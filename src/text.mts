// The counting rule of the shared conversation record: chars counts code
// points (so an emoji with a skin-tone modifier is 2, not the 4 UTF-16 units
// text.length would give), and a word is a run of non-whitespace characters
// that holds at least one letter or number. Whitespace is JavaScript's \s,
// which includes the no-break and ideographic spaces. Marks alone ("**",
// "-", ".") and a lone emoji are not words.
export function countText(text: string): { chars: number; words: number } {
  let chars = 0;
  let words = 0;
  let counted = false;
  for (const character of text) {
    chars += 1;
    if (/\s/u.test(character)) {
      counted = false;
    } else if (!counted && /[\p{L}\p{N}]/u.test(character)) {
      words += 1;
      counted = true;
    }
  }
  return { chars, words };
}
