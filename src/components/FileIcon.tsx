import {
  Database,
  File,
  FileArchive,
  FileBox,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileTerminal,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';
import { fileIconKind, type FileIconShape } from '../model/file-icons';

const shapes: Record<FileIconShape, LucideIcon> = {
  code: FileCode,
  braces: FileBraces,
  config: FileCog,
  text: FileText,
  image: FileImage,
  terminal: FileTerminal,
  lock: FileLock,
  archive: FileArchive,
  container: FileBox,
  database: Database,
  media: FileVideo,
  plain: File,
};

/** A file-type icon for `path`, tinted by language. */
export function FileIcon({ path }: { path: string }) {
  const kind = fileIconKind(path);
  const Shape = shapes[kind.shape];
  return (
    <Shape className="icon file-icon" data-type={kind.type} strokeWidth={1.6} aria-hidden="true" />
  );
}
