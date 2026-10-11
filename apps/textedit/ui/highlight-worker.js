// Highlights in the background, so typing never waits for it: gets
// { id, text, lang }, answers { id, lines } (syntax.js highlightLines).
import { highlightLines } from "./syntax.js";

self.onmessage = (e) => {
  const { id, text, lang } = e.data;
  self.postMessage({ id, lines: highlightLines(text, lang) });
};
