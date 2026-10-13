import { StreamLanguage } from '@codemirror/language';
import { go } from '@codemirror/legacy-modes/mode/go';
export function createSyntax() {
  return StreamLanguage.define(go);
}
