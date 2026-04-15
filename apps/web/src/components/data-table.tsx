"use client";

import { useState, useMemo } from "react";

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  filterable?: boolean;
  align?: "left" | "right";
  render?: (row: T) => React.ReactNode;
  getValue?: (row: T) => string | number | null;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  pageSize?: number;
  pageSizeOptions?: number[];
  emptyMessage?: string;
  // Server-side pagination
  serverPagination?: {
    total: number;
    page: number;
    onPageChange: (page: number) => void;
    pageSize: number;
    onPageSizeChange: (size: number) => void;
  };
}

type SortDir = "asc" | "desc" | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  pageSize: defaultPageSize = 10,
  pageSizeOptions = [10, 25, 50, 100],
  emptyMessage = "No data available.",
  serverPagination,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const isServerPaginated = !!serverPagination;

  // Client-side filtering
  const filtered = useMemo(() => {
    if (isServerPaginated) return data;
    const activeFilters = Object.entries(filters).filter(([, v]) => v.length > 0);
    if (activeFilters.length === 0) return data;

    return data.filter((row) =>
      activeFilters.every(([key, filterVal]) => {
        const col = columns.find((c) => c.key === key);
        const rawVal = col?.getValue ? col.getValue(row) : row[key];
        const strVal = String(rawVal ?? "").toLowerCase();
        return strVal.includes(filterVal.toLowerCase());
      })
    );
  }, [data, filters, columns, isServerPaginated]);

  // Client-side sorting
  const sorted = useMemo(() => {
    if (isServerPaginated) return filtered;
    if (!sortKey || !sortDir) return filtered;

    const col = columns.find((c) => c.key === sortKey);
    return [...filtered].sort((a, b) => {
      const aVal = col?.getValue ? col.getValue(a) : a[sortKey];
      const bVal = col?.getValue ? col.getValue(b) : b[sortKey];

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let cmp = 0;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [filtered, sortKey, sortDir, columns, isServerPaginated]);

  // Pagination
  const currentPageSize = isServerPaginated ? serverPagination.pageSize : pageSize;
  const currentPage = isServerPaginated ? serverPagination.page : page;
  const totalItems = isServerPaginated ? serverPagination.total : sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / currentPageSize));
  const pageData = isServerPaginated
    ? sorted
    : sorted.slice(currentPage * currentPageSize, (currentPage + 1) * currentPageSize);

  function handleSort(key: string) {
    if (sortKey === key) {
      if (sortDir === "asc") setSortDir("desc");
      else if (sortDir === "desc") { setSortKey(null); setSortDir(null); }
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function handlePageChange(newPage: number) {
    if (isServerPaginated) {
      serverPagination.onPageChange(newPage);
    } else {
      setPage(newPage);
    }
  }

  function handlePageSizeChange(newSize: number) {
    if (isServerPaginated) {
      serverPagination.onPageSizeChange(newSize);
    } else {
      setPageSize(newSize);
      setPage(0);
    }
  }

  function handleFilterChange(key: string, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    if (!isServerPaginated) setPage(0);
  }

  const hasFilters = columns.some((c) => c.filterable);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Top bar: page size selector */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400">
        <div className="flex items-center gap-2">
          <span>Show</span>
          <select
            value={currentPageSize}
            onChange={(e) => handlePageSizeChange(Number(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-blue-500"
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          <span>records</span>
        </div>
        <span>
          {totalItems === 0
            ? "No records"
            : `${currentPage * currentPageSize + 1}\u2013${Math.min((currentPage + 1) * currentPageSize, totalItems)} of ${totalItems}`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {/* Column headers */}
            <tr className="border-b border-zinc-800 text-zinc-400 text-left">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 ${col.align === "right" ? "text-right" : ""} ${col.sortable ? "cursor-pointer select-none hover:text-zinc-200" : ""}`}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && sortKey === col.key && (
                      <span className="text-blue-400">
                        {sortDir === "asc" ? "\u25B2" : "\u25BC"}
                      </span>
                    )}
                    {col.sortable && sortKey !== col.key && (
                      <span className="text-zinc-600">{"\u25B4"}</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
            {/* Filter row */}
            {hasFilters && (
              <tr className="border-b border-zinc-800">
                {columns.map((col) => (
                  <th key={col.key} className={`px-4 py-1.5 ${col.align === "right" ? "text-right" : ""}`}>
                    {col.filterable ? (
                      <input
                        type="text"
                        value={filters[col.key] || ""}
                        onChange={(e) => handleFilterChange(col.key, e.target.value)}
                        placeholder={`Filter...`}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                      />
                    ) : null}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-zinc-500">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageData.map((row, i) => (
                <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  {columns.map((col) => (
                    <td key={col.key} className={`px-4 py-3 ${col.align === "right" ? "text-right" : ""}`}>
                      {col.render ? col.render(row) : String(row[col.key] ?? "\u2014")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800 text-xs text-zinc-400">
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 0}
            className="px-3 py-1 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 7) {
                pageNum = i;
              } else if (currentPage < 3) {
                pageNum = i;
              } else if (currentPage > totalPages - 4) {
                pageNum = totalPages - 7 + i;
              } else {
                pageNum = currentPage - 3 + i;
              }

              return (
                <button
                  key={pageNum}
                  onClick={() => handlePageChange(pageNum)}
                  className={`w-7 h-7 rounded text-xs ${
                    pageNum === currentPage
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-800 border border-zinc-700 hover:bg-zinc-700"
                  }`}
                >
                  {pageNum + 1}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage >= totalPages - 1}
            className="px-3 py-1 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
