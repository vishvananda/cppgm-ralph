(function installRalphEntryDedupe(root) {
  function dedupeRichEntries(entries, identityForEntry, signatureForEntry) {
    const groups = new Map();

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const identity = identityForEntry(entry);
      if (!identity) continue;

      const signature = String(signatureForEntry(entry) ?? "");
      const existing = groups.get(identity);
      if (!existing) {
        groups.set(identity, {
          firstIndex: index,
          bestEntry: entry,
          bestLength: signature.length,
        });
      } else if (signature.length > existing.bestLength) {
        existing.bestEntry = entry;
        existing.bestLength = signature.length;
      }
    }

    const result = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const identity = identityForEntry(entry);
      if (!identity) {
        result.push(entry);
        continue;
      }
      const group = groups.get(identity);
      if (group?.firstIndex === index) {
        result.push(group.bestEntry);
      }
    }
    return result;
  }

  root.RALPH_ENTRY_DEDUPE = Object.freeze({ dedupeRichEntries });
})(globalThis);
