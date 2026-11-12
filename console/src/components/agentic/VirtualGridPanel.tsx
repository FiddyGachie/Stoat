import React from "react";
import type { ColDef } from "ag-grid-community";
import { GridPanel } from "../GridPanel.js";
import { assertNoPayeeColumns } from "./helpers.js";

type GridProps = React.ComponentProps<typeof GridPanel>;

/**
 * GridPanel in virtualize mode: pagination off, fixed 420 px body, row virtualization on.
 * CSV export is the grid's own exportDataAsCsv, which writes exactly the rows left after the
 * active sort and filters. In development it throws if a column field could show a payee.
 */
export const VirtualGridPanel: React.FC<Omit<GridProps, "virtualize" | "cols"> & { cols: ColDef[] }> = (props) => {
  assertNoPayeeColumns(props.cols);
  return <GridPanel {...props} virtualize />;
};
