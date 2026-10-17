import { invoke } from "@tauri-apps/api/core";
import type { AgentCatalog } from "@/types/agent";

export interface TavernCharacter {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  characterVersion: string;
  sourceFormat: string;
  hasAvatar: boolean;
  importedAt: number;
}

export interface TavernMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  failed: boolean;
}

export interface TavernStory {
  id: string;
  characterId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId?: string | null;
  messages: TavernMessage[];
  isGenerating: boolean;
}

export interface TavernSnapshot {
  characters: TavernCharacter[];
  stories: TavernStory[];
}

export interface TavernContextPreview {
  preHistory: string;
  postHistory: string;
  includedEntries: string[];
  excludedEntries: string[];
  worldInfoChars: number;
}

export const tavernApi = {
  getSnapshot: () => invoke<TavernSnapshot>("get_tavern_snapshot"),
  getCatalog: () => invoke<AgentCatalog>("get_tavern_catalog"),
  importCharacter: (path: string) =>
    invoke<TavernCharacter>("import_tavern_character", { path }),
  getAvatar: (characterId: string) =>
    invoke<{ dataUrl: string }>("get_tavern_avatar", { characterId }),
  createStory: (characterId: string, title?: string) =>
    invoke<TavernStory>("create_tavern_story", {
      characterId,
      ...(title ? { title } : {}),
    }),
  deleteStory: (storyId: string) =>
    invoke<void>("delete_tavern_story", { storyId }),
  previewContext: (storyId: string) =>
    invoke<TavernContextPreview>("preview_tavern_context", { storyId }),
  sendMessage: (storyId: string, text: string, modelId: string) =>
    invoke<TavernStory>("send_tavern_message", { storyId, text, modelId }),
};
