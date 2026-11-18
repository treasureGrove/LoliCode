import { useQuery } from "@tanstack/react-query";
import { BookHeart, Plus, Upload } from "lucide-react";
import {
  tavernApi,
  tavernSnapshotQuery,
  type TavernSnapshot,
} from "@/lib/api/tavern";
import companion from "@/assets/atelier/companion.png?inline";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const selectCharacters = (snapshot: TavernSnapshot) => snapshot.characters;

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
  const { data: characters } = useQuery({
    ...tavernSnapshotQuery,
    select: selectCharacters,
    refetchOnMount: false,
  });
  return (
    <div className="lolicode-sidebar-tavern-directory flex min-h-0 flex-1 flex-col pt-3">
      {!compact && (
        <div className="wb-section-label">
          <span>角色好友</span>
          <span className="wb-workspace-count">
            {(characters ?? []).length}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {(characters ?? []).map((character) => (
          <TavernSidebarCharacter
            key={character.id}
            character={character}
            compact={compact}
            selected={selectedId === character.id}
            onSelect={() => onSelect(character.id)}
          />
        ))}
      </div>
      <div className="pt-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="添加好友"
              title={compact ? "添加好友" : undefined}
              className="lolicode-tavern-add-btn"
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!compact && <span className="truncate">添加好友</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" sideOffset={8}>
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
  character: {
    id: string;
    name: string;
    hasAvatar: boolean;
    tags?: string[];
  };
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const bundled = character.id === "builtin:sillyloli";
  const avatar = useQuery({
    queryKey: ["tavern", "avatar", character.id],
    queryFn: () => tavernApi.getAvatar(character.id),
    enabled: !bundled && character.hasAvatar,
    staleTime: Infinity,
    retry: false,
  });
  const image = bundled ? companion : avatar.data?.dataUrl;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={character.name}
      title={compact ? character.name : undefined}
      aria-current={selected ? "page" : undefined}
      className="lolicode-tavern-friend"
    >
      <span className="lolicode-tavern-friend-avatar">
        {image ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          character.name.slice(0, 1)
        )}
      </span>
      {!compact && (
        <span className="min-w-0 flex-1">
          <span className="block truncate">{character.name}</span>
          {character.tags && character.tags.length > 0 && (
            <span className="lolicode-tavern-friend-sub truncate">
              {character.tags.slice(0, 2).join(" · ")}
            </span>
          )}
        </span>
      )}
    </button>
  );
}
