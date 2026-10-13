export function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="patch-view">
      {patch
        ? patch.split('\n').map((line, index) => (
            <div
              key={index}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'diff-added'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'diff-removed'
                    : line.startsWith('@@')
                      ? 'diff-hunk'
                      : ''
              }
            >
              {line || ' '}
            </div>
          ))
        : 'No textual changes.'}
    </pre>
  );
}
