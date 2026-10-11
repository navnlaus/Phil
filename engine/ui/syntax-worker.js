// Highlights in the background, so typing (textedit) and scrolling (phil's
// text tiles) never wait for it. Requests and answers:
//   { id, text, lang }               → { id, lines }: HTML per line (highlightLines)
//   { id, text, path, runs: true }   → { id, lang, runs }: the language detected
//                                      from the path and text, colored runs per
//                                      line (highlightRuns)
import { detectLanguage, highlightLines, highlightRuns } from "./syntax.js";

self.onmessage = (e) => {
  const { id, text, lang, path, runs } = e.data;
  if (!runs) return self.postMessage({ id, lines: highlightLines(text, lang) });
  const detected = lang ?? detectLanguage(path, text);
  self.postMessage({ id, lang: detected, runs: highlightRuns(text, detected) });
};
