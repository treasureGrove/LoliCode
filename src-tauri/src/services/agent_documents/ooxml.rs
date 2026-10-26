use super::*;
use quick_xml::{events::Event, Reader};

const MAX_ARCHIVE: u64 = 64 * 1024 * 1024;
const MAX_PART: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_NODES: usize = 200_000;
const MAX_CELLS: usize = 100_000;

#[derive(Default, Debug)]
struct Node {
    name: String,
    attrs: HashMap<String, String>,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|n| n.name == name)
    }
    fn find(&self, name: &str) -> Option<&Node> {
        if self.name == name {
            Some(self)
        } else {
            self.children.iter().find_map(|n| n.find(name))
        }
    }
    fn descendants<'a>(&'a self, name: &str, output: &mut Vec<&'a Node>) {
        for child in &self.children {
            if child.name == name {
                output.push(child);
            }
            child.descendants(name, output);
        }
    }
    fn all<'a>(&'a self, name: &str) -> Vec<&'a Node> {
        let mut values = Vec::new();
        self.descendants(name, &mut values);
        values
    }
    fn run_text(&self) -> String {
        match self.name.as_str() {
            "t" => self.text.clone(),
            "tab" => "\t".into(),
            "br" | "cr" => "\n".into(),
            _ => self.children.iter().map(Node::run_text).collect(),
        }
    }
}

struct Package {
    archive: zip::ZipArchive<Cursor<Vec<u8>>>,
    names: HashSet<String>,
    read: u64,
}

impl Package {
    fn new(bytes: &[u8]) -> Result<Self, String> {
        if !bytes.starts_with(b"PK\x03\x04") {
            return Err("Office file is not an OOXML ZIP package.".into());
        }
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| format!("Invalid Office ZIP: {e}"))?;
        if archive.len() > MAX_ENTRIES {
            return Err("Office archive contains too many parts.".into());
        }
        let mut total = 0u64;
        let mut names = HashSet::new();
        for index in 0..archive.len() {
            let part = archive
                .by_index(index)
                .map_err(|e| format!("Cannot inspect Office archive: {e}"))?;
            let name = part.name();
            if name.starts_with('/')
                || name.contains('\\')
                || name
                    .split('/')
                    .any(|piece| piece == ".." || piece.contains(':'))
                || !names.insert(name.to_owned())
            {
                return Err("Office archive has duplicate or unsafe part paths.".into());
            }
            if part.is_dir() {
                continue;
            }
            // Images are never decoded, but their declared size still counts against the package budget.
            total = total
                .checked_add(part.size())
                .ok_or("Office archive size overflow.")?;
            if total > MAX_ARCHIVE
                || part.size() > 32 * 1024 * 1024
                || (part.size() > 1024 * 1024 && part.size() / part.compressed_size().max(1) > 500)
            {
                return Err("Office archive exceeds its safe decompression limits.".into());
            }
            if part
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("Office archive must not contain symlink entries.".into());
            }
        }
        if !names.contains("[Content_Types].xml") {
            return Err("Office archive has no content types manifest.".into());
        }
        Ok(Self {
            archive,
            names,
            read: 0,
        })
    }

    fn xml(&mut self, name: &str) -> Result<Node, String> {
        let mut part = self
            .archive
            .by_name(name)
            .map_err(|_| format!("Office package is missing {name}."))?;
        if part.size() > MAX_PART {
            return Err(format!("Office XML part exceeds 8 MiB: {name}"));
        }
        let mut data = Vec::with_capacity(part.size() as usize);
        (&mut part)
            .take(MAX_PART + 1)
            .read_to_end(&mut data)
            .map_err(|e| format!("Cannot decompress Office XML {name}: {e}"))?;
        self.read = self
            .read
            .checked_add(data.len() as u64)
            .ok_or("Office archive read overflow.")?;
        if data.len() as u64 > MAX_PART || self.read > MAX_ARCHIVE {
            return Err("Office XML decompression budget exceeded.".into());
        }
        xml(&data)
    }

    fn optional_xml(&mut self, name: &str) -> Result<Option<Node>, String> {
        if self.names.contains(name) {
            self.xml(name).map(Some)
        } else {
            Ok(None)
        }
    }

    fn relations(&mut self, source: &str) -> Result<HashMap<String, String>, String> {
        let (directory, file) = source.rsplit_once('/').unwrap_or(("", source));
        let rel_path = if directory.is_empty() {
            format!("_rels/{file}.rels")
        } else {
            format!("{directory}/_rels/{file}.rels")
        };
        let Some(root) = self.optional_xml(&rel_path)? else {
            return Ok(HashMap::new());
        };
        let mut result = HashMap::new();
        for relation in root.all("Relationship") {
            if relation
                .attr("TargetMode")
                .is_some_and(|v| v.eq_ignore_ascii_case("External"))
            {
                continue;
            }
            let (Some(id), Some(target)) = (relation.attr("Id"), relation.attr("Target")) else {
                continue;
            };
            let target = package_target(directory, target)?;
            if result.insert(id.into(), target).is_some() {
                return Err("Office relationship identifiers must be unique.".into());
            }
        }
        Ok(result)
    }
}

fn package_target(directory: &str, target: &str) -> Result<String, String> {
    if target.contains('\\')
        || target.contains(':')
        || target.contains('#')
        || target.contains('?')
        || target.chars().any(char::is_control)
    {
        return Err("Unsafe internal Office relationship.".into());
    }
    let mut pieces: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        directory.split('/').filter(|v| !v.is_empty()).collect()
    };
    for piece in target.split('/') {
        match piece {
            "" | "." => {}
            ".." => {
                if pieces.pop().is_none() {
                    return Err("Office relationship escapes its package.".into());
                }
            }
            _ => pieces.push(piece),
        }
    }
    Ok(pieces.join("/"))
}

fn local_name(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.rsplit(|b| *b == b':').next().unwrap_or(bytes);
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| "Office XML name is not UTF-8.".into())
}

fn xml(bytes: &[u8]) -> Result<Node, String> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = true;
    let mut stack = vec![Node::default()];
    let mut count = 0;
    loop {
        match reader
            .read_event()
            .map_err(|e| format!("Invalid Office XML: {e}"))?
        {
            Event::Start(event) | Event::Empty(event) => {
                // Empty events are expanded below using the event's source marker.
                let empty =
                    bytes.get(reader.buffer_position().saturating_sub(2) as usize) == Some(&b'/');
                count += 1;
                if count > MAX_NODES || stack.len() > 64 {
                    return Err("Office XML exceeds its node/depth limit.".into());
                }
                let mut node = Node {
                    name: local_name(event.name().as_ref())?,
                    ..Default::default()
                };
                for attribute in event.attributes() {
                    let attribute =
                        attribute.map_err(|e| format!("Invalid Office XML attribute: {e}"))?;
                    let key = local_name(attribute.key.as_ref())?;
                    if key == "xmlns" || attribute.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|e| format!("Invalid Office XML attribute: {e}"))?
                        .into_owned();
                    let qualified = std::str::from_utf8(attribute.key.as_ref())
                        .map_err(|_| "Invalid XML attribute name.")?
                        .to_owned();
                    if qualified.contains(':') {
                        // Relationship namespace prefixes need not be named `r`;
                        // preserve their ID ahead of an unqualified numeric slide ID.
                        node.attrs.insert(key, value.clone());
                    } else {
                        node.attrs.entry(key).or_insert_with(|| value.clone());
                    }
                    node.attrs.insert(qualified, value);
                }
                if empty {
                    stack.last_mut().unwrap().children.push(node);
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                if stack.len() <= 1 {
                    return Err("Invalid Office XML nesting.".into());
                }
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            Event::Text(text) => {
                stack.last_mut().unwrap().text.push_str(
                    &text
                        .decode()
                        .map_err(|e| format!("Invalid Office XML text: {e}"))?,
                );
            }
            Event::CData(text) => {
                stack.last_mut().unwrap().text.push_str(
                    &text
                        .decode()
                        .map_err(|e| format!("Invalid Office XML text: {e}"))?,
                );
            }
            Event::GeneralRef(reference) => {
                let reference = reference
                    .decode()
                    .map_err(|e| format!("Invalid Office XML entity: {e}"))?;
                let encoded = format!("&{reference};");
                let value = quick_xml::escape::unescape(&encoded)
                    .map_err(|_| "Custom Office XML entities are not supported.")?;
                stack.last_mut().unwrap().text.push_str(&value);
            }
            Event::DocType(_) => return Err("Office XML DTDs are not allowed.".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 || stack[0].children.len() != 1 {
        return Err("Office XML must contain one complete root.".into());
    }
    Ok(stack.pop().unwrap())
}

pub(super) fn parse(
    bytes: &[u8],
    kind: &str,
) -> Result<(Vec<DocumentSection>, Vec<String>), String> {
    let mut package = Package::new(bytes)?;
    let _manifest = package.xml("[Content_Types].xml")?;
    let mut warnings = vec!["Office preview shows extracted text and stored cell values; original page layout, charts, images and formula recalculation are not rendered.".into()];
    if package
        .names
        .iter()
        .any(|name| name.ends_with("vbaProject.bin"))
    {
        warnings.push("This package contains macros; they were not executed.".into());
    }
    let sections = match kind {
        "docx" => word(&mut package, &mut warnings)?,
        "xlsx" => spreadsheet(&mut package, &mut warnings)?,
        "pptx" => slides(&mut package, &mut warnings)?,
        _ => return Err("Unsupported OOXML kind.".into()),
    };
    Ok((sections, warnings))
}

fn word(package: &mut Package, warnings: &mut Vec<String>) -> Result<Vec<DocumentSection>, String> {
    let root = package.xml("word/document.xml")?;
    let body = root.find("body").ok_or("Word document has no body.")?;
    let mut sections = Vec::new();
    let (mut paragraph, mut table) = (0, 0);
    fn add_blocks(
        parent: &Node,
        output: &mut Vec<DocumentSection>,
        paragraph: &mut usize,
        table: &mut usize,
    ) -> Result<(), String> {
        for node in &parent.children {
            match node.name.as_str() {
                "p" => {
                    *paragraph += 1;
                    output.push(DocumentSection {
                        id: format!("p:{paragraph}"),
                        label: format!("Paragraph {paragraph}"),
                        text: node.run_text(),
                        rows: Vec::new(),
                    });
                }
                "tbl" => {
                    *table += 1;
                    let rows: Vec<Vec<DocumentCell>> = node
                        .children
                        .iter()
                        .filter(|n| n.name == "tr")
                        .enumerate()
                        .map(|(r, row)| {
                            row.children
                                .iter()
                                .filter(|n| n.name == "tc")
                                .enumerate()
                                .map(|(c, cell)| DocumentCell {
                                    reference: format!("r{}c{}", r + 1, c + 1),
                                    value: cell
                                        .all("p")
                                        .into_iter()
                                        .map(Node::run_text)
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    formula: None,
                                })
                                .collect()
                        })
                        .collect();
                    output.push(DocumentSection {
                        id: format!("t:{table}"),
                        label: format!("Table {table}"),
                        text: cells_text(&rows),
                        rows,
                    });
                }
                // Content controls / tracked insertion containers keep body order.
                "sdt" | "sdtContent" | "customXml" | "ins" => {
                    add_blocks(node, output, paragraph, table)?
                }
                _ => {}
            }
            if output.len() > MAX_SECTIONS {
                return Err("Word document contains too many paragraphs/tables.".into());
            }
        }
        Ok(())
    }
    add_blocks(body, &mut sections, &mut paragraph, &mut table)?;
    // Headers, footers and notes are part of the readable document, after its body.
    let mut extras: Vec<_> = package
        .names
        .iter()
        .filter(|name| {
            name.starts_with("word/")
                && name.ends_with(".xml")
                && (name.starts_with("word/header")
                    || name.starts_with("word/footer")
                    || matches!(name.as_str(), "word/footnotes.xml" | "word/endnotes.xml"))
        })
        .cloned()
        .collect();
    extras.sort();
    for name in extras {
        let extra = package.xml(&name)?;
        for node in extra.all("p") {
            let text = node.run_text();
            if text.is_empty() {
                continue;
            }
            paragraph += 1;
            sections.push(DocumentSection {
                id: format!("p:{paragraph}"),
                label: format!("{name} — paragraph {paragraph}"),
                text,
                rows: Vec::new(),
            });
        }
    }
    if body.find("altChunk").is_some() {
        warnings.push("Embedded alternate-format content is not extracted.".into());
    }
    Ok(sections)
}

fn spreadsheet(
    package: &mut Package,
    warnings: &mut Vec<String>,
) -> Result<Vec<DocumentSection>, String> {
    let workbook = package.xml("xl/workbook.xml")?;
    let relations = package.relations("xl/workbook.xml")?;
    let mut shared = Vec::new();
    if let Some(strings) = package.optional_xml("xl/sharedStrings.xml")? {
        for item in strings.all("si") {
            shared.push(item.run_text());
        }
    }
    let mut sections = Vec::new();
    let mut cells_count = 0;
    let mut has_formula = false;
    let mut text_size = 0usize;
    for sheet in workbook.all("sheet") {
        let name = sheet.attr("name").ok_or("Worksheet has no name.")?;
        let id = sheet
            .attr("r:id")
            .or_else(|| sheet.attr("id"))
            .ok_or("Worksheet has no relationship ID.")?;
        let target = relations
            .get(id)
            .ok_or("Worksheet relationship is missing or external.")?;
        let worksheet = package.xml(target)?;
        let mut rows: BTreeMap<usize, Vec<DocumentCell>> = BTreeMap::new();
        let mut used = HashSet::new();
        let Some(data) = worksheet.find("sheetData") else {
            sections.push(DocumentSection {
                id: format!("sheet:{name}"),
                label: name.into(),
                text: String::new(),
                rows: Vec::new(),
            });
            continue;
        };
        for row in data.children.iter().filter(|node| node.name == "row") {
            let row_number = row
                .attr("r")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or_else(|| rows.keys().next_back().copied().unwrap_or(0) + 1);
            let mut next_column = 1;
            for cell in row.children.iter().filter(|node| node.name == "c") {
                cells_count += 1;
                if cells_count > MAX_CELLS {
                    return Err("Workbook exceeds the 100,000 stored-cell limit.".into());
                }
                let reference = cell
                    .attr("r")
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{}{row_number}", column_name(next_column)));
                let (column, actual_row) = cell_coordinate(&reference)
                    .ok_or("Workbook contains an invalid cell coordinate.")?;
                next_column = column + 1;
                if !used.insert(reference.clone()) {
                    return Err("Workbook contains duplicate cell coordinates.".into());
                }
                let stored = cell.child("v").map(|n| n.text.as_str()).unwrap_or("");
                let value = match cell.attr("t").unwrap_or("n") {
                    "s" => {
                        let index = stored
                            .parse::<usize>()
                            .map_err(|_| "Invalid shared-string index.")?;
                        shared
                            .get(index)
                            .ok_or("Shared-string index is outside the string table.")?
                            .clone()
                    }
                    "inlineStr" => cell.child("is").map(Node::run_text).unwrap_or_default(),
                    "b" => match stored {
                        "1" => "TRUE".into(),
                        "0" => "FALSE".into(),
                        _ => stored.into(),
                    },
                    _ => stored.into(),
                };
                let formula = cell.child("f").map(|node| node.text.clone());
                text_size = text_size
                    .saturating_add(value.len())
                    .saturating_add(formula.as_ref().map_or(0, String::len));
                if text_size > MAX_TEXT / 2 {
                    return Err("Workbook exceeds the safe extracted-text limit.".into());
                }
                has_formula |= formula.is_some();
                rows.entry(actual_row).or_default().push(DocumentCell {
                    reference,
                    value,
                    formula,
                });
            }
        }
        let rows: Vec<Vec<DocumentCell>> = rows
            .into_values()
            .map(|mut row| {
                row.sort_by_key(|c| cell_coordinate(&c.reference).map(|v| v.0).unwrap_or(0));
                row
            })
            .collect();
        sections.push(DocumentSection {
            id: format!("sheet:{name}"),
            label: name.into(),
            text: cells_text(&rows),
            rows,
        });
    }
    if has_formula {
        warnings.push("Formula results are the values cached in the workbook; formulas and external data are never recalculated.".into());
    }
    warnings.push("Numeric/date formatting is shown as the stored cell value; cell references preserve exact workbook coordinates.".into());
    Ok(sections)
}

fn column_name(mut number: usize) -> String {
    let mut value = Vec::new();
    while number > 0 {
        number -= 1;
        value.push(b'A' + (number % 26) as u8);
        number /= 26;
    }
    value.reverse();
    String::from_utf8(value).unwrap_or_default()
}

fn slides(
    package: &mut Package,
    warnings: &mut Vec<String>,
) -> Result<Vec<DocumentSection>, String> {
    let presentation = package.xml("ppt/presentation.xml")?;
    let relations = package.relations("ppt/presentation.xml")?;
    let mut sections = Vec::new();
    for (index, slide) in presentation.all("sldId").iter().enumerate() {
        let id = slide
            .attr("r:id")
            .or_else(|| slide.attr("id"))
            .ok_or("Slide has no relationship ID.")?;
        let target = relations
            .get(id)
            .ok_or("Slide relationship is missing or external.")?;
        let root = package.xml(target)?;
        let paragraphs: Vec<_> = root
            .all("p")
            .into_iter()
            .map(Node::run_text)
            .filter(|value| !value.is_empty())
            .collect();
        let mut rows = Vec::new();
        for table in root.all("tbl") {
            for row in table.children.iter().filter(|node| node.name == "tr") {
                let row_number = rows.len() + 1;
                rows.push(
                    row.children
                        .iter()
                        .filter(|node| node.name == "tc")
                        .enumerate()
                        .map(|(column, cell)| DocumentCell {
                            reference: format!("r{row_number}c{}", column + 1),
                            value: cell
                                .all("p")
                                .into_iter()
                                .map(Node::run_text)
                                .collect::<Vec<_>>()
                                .join("\n"),
                            formula: None,
                        })
                        .collect(),
                );
            }
        }
        let mut text = paragraphs.join("\n");
        // Include presenter notes without importing theme/layout text into every slide.
        let slide_relations = package.relations(target)?;
        if let Some(note_path) = slide_relations
            .values()
            .find(|path| path.starts_with("ppt/notesSlides/") && path.ends_with(".xml"))
        {
            let note = package.xml(note_path)?;
            let notes = note
                .all("p")
                .into_iter()
                .map(Node::run_text)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if !notes.is_empty() {
                text.push_str("\n[Presenter notes]\n");
                text.push_str(&notes);
            }
        }
        sections.push(DocumentSection {
            id: format!("slide:{}", index + 1),
            label: format!("Slide {}", index + 1),
            text,
            rows,
        });
        if sections.len() > MAX_SECTIONS {
            return Err("Presentation contains too many slides.".into());
        }
    }
    if sections.is_empty() {
        warnings.push("Presentation contains no slides.".into());
    }
    Ok(sections)
}
