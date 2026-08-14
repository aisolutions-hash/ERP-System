export default function Table({ columns, data, keyField = 'id', onRowClick }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 uppercase tracking-wide border-b border-gray-200">
            {columns.map((c) => (
              <th key={c.key} className="px-4 py-3 font-medium whitespace-nowrap">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.map((row, ri) => (
            <tr
              key={row[keyField] ?? ri}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'cursor-pointer hover:bg-amber-50/50' : 'hover:bg-gray-50/50'}
            >
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-3 text-slate-700 whitespace-nowrap">
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}