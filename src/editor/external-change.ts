import { Annotation } from '@codemirror/state';
/** Marks disk synchronization so it never loops back into document.change. */
export const externalDocumentChange = Annotation.define<boolean>();
