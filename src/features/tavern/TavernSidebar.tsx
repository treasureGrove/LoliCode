import { useQuery } from "@tanstack/react-query";
import { BookHeart, Plus, Upload } from "lucide-react";
import { tavernApi } from "@/lib/api/tavern";
import companion from "@/assets/atelier/companion.png";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function TavernSidebar({
  compact,
  selectedId,
  onSelect,
  onAdd,
}: {
  compact: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (source: "preset" | "card") => void;
}) {
  const { data } = useQuery({
    queryKey: ["tavern", "snapshot"],
    queryFn: tavernApi.getSnapshot,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-4">
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {(data?.characters ?? []).map((character) => (
          <TavernSidebarCharacter
            key={character.id}
            character={character}
            compact={compact}
            selected={selectedId === character.id}
            onSelect={() => onSelect(character.id)}
          />
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="添加好友"
              title={compact ? "添加好友" : undefined}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-subtle"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-subtle text-fg-2">
                <Plus className="h-5 w-5" aria-hidden="true" />
              </span>
              {!compact && <span className="truncate">添加好友</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" sideOffset={8}>
            <DropdownMenuItem onSelect={() => onAdd("preset")}>
              <BookHeart className="mr-2 h-4 w-4" aria-hidden="true" />
              从预设添加
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAdd("card")}>
              <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
              从SillyTavern卡片导入
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function TavernSidebarCharacter({
  character,
  compact,
  selected,
  onSelect,
}: {
  character: { id: string; name: string; hasAvatar: boolean };
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const avatar = useQuery({
    queryKey: ["tavern", "avatar", character.id],
    queryFn: () => tavernApi.getAvatar(character.id),
    enabled: character.hasAvatar,
  });
  const image =
    character.id === "builtin:sillyloli" ? companion : avatar.data?.dataUrl;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={character.name}
      title={compact ? character.name : undefined}
      aria-current={selected ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-subtle ${selected ? "bg-action/20 font-semibold text-action-text ring-1 ring-inset ring-action/30" : ""}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-subtle">
        {image ? (
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : (
          character.name.slice(0, 1)
        )}
      </span>
      {!compact && <span className="truncate">{character.name}</span>}
    </button>
  );
}
