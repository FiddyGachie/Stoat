import React, { useCallback, useEffect, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, GridReadyEvent } from "ag-grid-community";
import {
  ModuleRegistry,
  AllCommunityModule,
  ValidationModule,
} from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import { Download, TriangleAlert, X } from "lucide-react";
import { EmptyState, Icon, Loading } from "./ui.js";

// AG Grid v36 modular build.
// AllCommunityModule registers every community feature in one call:
// CellStyleModule, CellRendererModule, PaginationModule, QuickFilterModule,
// CsvExportModule, ColumnAutoSizeModule, RowStyleModule, etc.
// ValidationModule surfaces full human-readable error messages in the browser console.
ModuleRegistry.registerModules([AllCommunityModule, ValidationModule]);

interface Props {
  title: string;
  rows: unknown[];
  cols: ColDef[];
  loading?: boolean;
  error?: string;
  onRowClick?: (row: unknown) => void;
  badge?: React.ReactNode;
  getRowId?: (params: { data: unknown }) => string;
  quickFilter?: string;
  onQuickFilterChange?: (text: string) => void;
  actions?: React.ReactNode;
  /** Hide the built-in CSV button when the caller offers a server-side export. */
  hideCsv?: boolean;
  /** Pagination off, fixed body height, row virtualization on. For large row counts. */
  virtualize?: boolean;
}

/** A data table presented as a glass card, with filtering, CSV export, loading, empty and error states. */
export const GridPanel: React.FC<Props> = ({
  title,
  rows,
  cols,
  loading,
  error,
  onRowClick,
  badge,
  getRowId,
  quickFilter,
  onQuickFilterChange,
  actions,
  hideCsv,
  virtualize,
}) => {
  const [filterText, setFilterText] = useState(quickFilter ?? "");
  const gridApiRef = useRef<GridApi | null>(null);

  useEffect(() => {
    if (quickFilter !== undefined) {
      setFilterText(quickFilter);
    }
  }, [quickFilter]);

  const handleFilterChange = (val: string) => {
    setFilterText(val);
    onQuickFilterChange?.(val);
  };

  const onGridReady = useCallback((params: GridReadyEvent) => {
    gridApiRef.current = params.api;
  }, []);

  const exportCsv = useCallback(() => {
    if (gridApiRef.current) {
      gridApiRef.current.exportDataAsCsv({
        fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`,
      });
    }
  }, [title]);

  if (error) {
    return (
      <section className="card grid-card" aria-label={title}>
        <div className="grid-card-head"><h2>{title}</h2></div>
        <div className="notice notice-error" role="alert" style={{ margin: "var(--space-4)" }}>
          <Icon icon={TriangleAlert} />
          <span>Could not load {title.toLowerCase()}: {error}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="card grid-card" aria-label={title}>
      <div className="grid-card-head">
        <h2>{title}</h2>
        {badge}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {rows.length > 0 && (
            <div className="grid-search-wrap" style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <input
                type="search"
                className="grid-search-input"
                placeholder="Filter table…"
                aria-label={`Filter ${title}`}
                value={filterText}
                onChange={(e) => handleFilterChange(e.target.value)}
              />
              {filterText && (
                <button
                  type="button"
                  className="icon-button"
                  style={{ position: "absolute", right: "4px", minHeight: "24px", width: "24px", padding: 0 }}
                  aria-label="Clear filter"
                  onClick={() => handleFilterChange("")}
                >
                  <Icon icon={X} />
                </button>
              )}
            </div>
          )}
          {rows.length > 0 && !hideCsv && (
            <button
              type="button"
              className="small-button"
              onClick={exportCsv}
              aria-label={`Export ${title} as CSV`}
              title="Export as CSV"
            >
              <Icon icon={Download} />
              <span>CSV</span>
            </button>
          )}
          {actions}
          <span className="grid-card-count" aria-live="polite">
            {loading ? "Loading…" : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>
      <div className="grid-card-body">
        {loading && rows.length === 0 ? (
          <Loading label={`Loading ${title.toLowerCase()}…`} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing here yet">Records will appear here as soon as there is activity.</EmptyState>
        ) : (
          <div className="ag-theme-quartz" style={virtualize ? { height: 420 } : undefined}>
            <AgGridReact
              theme="legacy"
              rowData={rows as Record<string, unknown>[]}
              columnDefs={cols}
              getRowId={getRowId ?? ((p: { data: unknown }) => (p.data as Record<string, unknown>)["id"] as string)}
              onRowClicked={onRowClick ? (e) => onRowClick(e.data) : undefined}
              onCellKeyDown={
                onRowClick
                  ? (e) => {
                    // Keyboard users select a row with Enter on a focused cell.
                    const key = (e.event as KeyboardEvent | null)?.key;
                    if (key === "Enter") onRowClick(e.data);
                  }
                  : undefined
              }
              onGridReady={onGridReady}
              quickFilterText={filterText}
              pagination={!virtualize}
              paginationPageSize={25}
              paginationPageSizeSelector={[10, 25, 50, 100]}

              defaultColDef={{ sortable: true, filter: true, resizable: true, flex: 1, minWidth: 110 }}
              enableCellTextSelection={true}
              domLayout={virtualize ? "normal" : "autoHeight"}
            />
          </div>
        )}
      </div>
    </section>
  );
};
