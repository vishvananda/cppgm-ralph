// Strands currently omits reasoning blocks when it reconstructs Responses
// history. Reinsert the encrypted output item before its corresponding tool
// call in later stateless requests, without exposing its contents to Strands.
export class ReasoningReplay {
  constructor() {
    this.byCallId = new Map();
  }

  remember(output) {
    if (!Array.isArray(output)) return;
    let preceding = [];
    for (const item of output) {
      if (item?.type === "reasoning" && item.encrypted_content) {
        preceding.push(item);
      } else if (item?.type === "function_call" && item.call_id) {
        if (preceding.length) this.byCallId.set(item.call_id, preceding);
        preceding = [];
      }
    }
  }

  apply(input) {
    if (!Array.isArray(input) || !this.byCallId.size) return input;
    const result = [];
    for (const item of input) {
      if (item?.type === "function_call") {
        result.push(...(this.byCallId.get(item.call_id) ?? []));
      }
      result.push(item);
    }
    return result;
  }
}
