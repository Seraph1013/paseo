import type { PluginComposerDraft, PluginComposerRef } from "@getpaseo/plugin/client";
import { buildDraftStoreKey } from "@/stores/draft-keys";

interface ComposerAdapter {
  getText(): string;
  replaceText(text: string): void;
}
interface ComposerEntry {
  adapter: ComposerAdapter | null;
  snapshot: PluginComposerDraft;
  listeners: Set<(draft: PluginComposerDraft) => void>;
}
const entries = new Map<string, ComposerEntry>();
function entryFor(key: string): ComposerEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      adapter: null,
      snapshot: { text: "", revision: 0, submissionRevision: 0 },
      listeners: new Set(),
    };
    entries.set(key, entry);
  }
  return entry;
}
function publish(entry: ComposerEntry): void {
  for (const listener of entry.listeners) listener(entry.snapshot);
}
function read(entry: ComposerEntry): PluginComposerDraft {
  if (!entry.adapter) throw new Error("Open this agent's composer before inserting a prompt.");
  const text = entry.adapter.getText();
  if (text !== entry.snapshot.text) {
    entry.snapshot = { ...entry.snapshot, text, revision: entry.snapshot.revision + 1 };
  }
  return entry.snapshot;
}
export function registerPluginComposer(key: string, adapter: ComposerAdapter): () => void {
  const entry = entryFor(key);
  entry.adapter = adapter;
  read(entry);
  publish(entry);
  return () => {
    if (entry.adapter === adapter) entry.adapter = null;
  };
}
export function notifyPluginComposer(key: string): void {
  const entry = entries.get(key);
  if (!entry?.adapter) return;
  read(entry);
  publish(entry);
}
export function markPluginComposerSubmitted(key: string): void {
  const entry = entryFor(key);
  entry.snapshot = { ...entry.snapshot, submissionRevision: entry.snapshot.submissionRevision + 1 };
  publish(entry);
}
export function createPluginComposer(serverId: string, signal: AbortSignal) {
  return {
    ref(agentId: string): PluginComposerRef {
      const key = buildDraftStoreKey({ serverId, agentId });
      const entry = entryFor(key);
      function requireAlive() {
        if (signal.aborted)
          throw new Error("The prompt plugin has stopped. Reopen Prompts to retry.");
      }
      return {
        getDraft() {
          requireAlive();
          return read(entry);
        },
        replaceDraft(input) {
          requireAlive();
          const current = read(entry);
          if (current.revision !== input.revision)
            throw new Error("Your draft changed. Select the prompt again to retry.");
          entry.adapter!.replaceText(input.text);
          entry.snapshot = { ...current, text: input.text, revision: current.revision + 1 };
          publish(entry);
          return entry.snapshot;
        },
        subscribe(listener) {
          requireAlive();
          entry.listeners.add(listener);
          function remove() {
            entry.listeners.delete(listener);
            signal.removeEventListener("abort", remove);
          }
          signal.addEventListener("abort", remove, { once: true });
          return remove;
        },
      };
    },
  };
}
