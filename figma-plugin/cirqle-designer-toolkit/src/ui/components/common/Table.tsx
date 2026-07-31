import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render: (row: T) => ReactNode;
}

export function Table<T extends { id: string }>({
  columns,
  rows,
  selected,
  onToggleSelect,
  emptyMessage = 'Nothing here yet.',
}: {
  columns: Column<T>[];
  rows: T[];
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return <div className="cdt-table-empty">{emptyMessage}</div>;
  }

  return (
    <div className="cdt-table-wrap">
      <table className="cdt-table">
        <thead>
          <tr>
            {onToggleSelect ? <th style={{ width: 28 }} /> : null}
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={selected?.has(row.id) ? 'cdt-table__row--selected' : ''}>
              {onToggleSelect ? (
                <td>
                  <input
                    type="checkbox"
                    checked={selected?.has(row.id) ?? false}
                    onChange={() => onToggleSelect(row.id)}
                  />
                </td>
              ) : null}
              {columns.map((c) => (
                <td key={c.key}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
