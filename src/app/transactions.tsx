import { useEffect, useMemo, useRef, useState } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
} from "ag-grid-community"
import { AgGridReact } from "ag-grid-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { APP_ERRORS, getErrorMessage } from "@/lib/errors"

ModuleRegistry.registerModules([AllCommunityModule])

const gridTheme = themeQuartz.withParams({
  accentColor: "var(--primary)",
  backgroundColor: "var(--card)",
  borderColor: "var(--border)",
  browserColorScheme: "inherit",
  fontFamily: "inherit",
  foregroundColor: "var(--card-foreground)",
  headerBackgroundColor: "var(--muted)",
  headerTextColor: "var(--muted-foreground)",
})

const EVENT_LABELS: Record<string, string> = {
  authorized: "Bet authorized",
  captured: "Bet charged",
  failed: "Bet failed",
  payout_failed: "Payout failed",
  payout_refunded: "Payout refunded",
  payout_sent: "Payout initiated",
  payout_skipped: "Payout skipped",
  refunded: "Bet refunded",
  unpaid: "Bet unpaid",
  voided: "Bet released",
}

type StakeEvent = {
  id: string
  createdAt: string
  event: string
  amountCents: number
  cycleId: string
}

const columns: ColDef<StakeEvent>[] = [
  {
    headerName: "Date",
    valueGetter: ({ data }) => (data ? new Date(data.createdAt) : null),
    valueFormatter: ({ value }) => (value ? value.toLocaleString() : ""),
    filter: "agDateColumnFilter",
    sort: "desc",
  },
  {
    headerName: "Boat round ID",
    field: "cycleId",
    minWidth: 240,
  },
  {
    headerName: "Event",
    field: "event",
    valueFormatter: ({ value }) => EVENT_LABELS[value] ?? value,
  },
  {
    headerName: "Amount",
    field: "amountCents",
    valueFormatter: ({ value }) => `$${(value / 100).toFixed(2)}`,
    filter: "agNumberColumnFilter",
    valueGetter: ({ data }) => (data ? data.amountCents : null),
  },
]

export default function TransactionsCard({
  supabase,
}: {
  supabase: SupabaseClient
}) {
  const gridRef = useRef<AgGridReact<StakeEvent>>(null)
  const [rows, setRows] = useState<StakeEvent[] | null>(null)
  const [error, setError] = useState("")
  const defaultColDef = useMemo<ColDef>(
    () => ({ flex: 1, minWidth: 120, filter: true, sortable: true }),
    []
  )

  useEffect(() => {
    let active = true
    void supabase
      .from("stake_events")
      .select("id, created_at, event, amount_cents, cycle_id")
      .order("created_at", { ascending: false })
      .limit(500)
      .then(({ data, error: loadError }) => {
        if (!active) return
        if (loadError || !data) {
          setError(getErrorMessage(loadError, APP_ERRORS.history_load))
          return
        }
        setRows(
          data.map((row) => ({
            id: String(row.id),
            createdAt: String(row.created_at),
            event: String(row.event),
            amountCents: Number(row.amount_cents),
            cycleId: String(row.cycle_id),
          }))
        )
      })
    return () => {
      active = false
    }
  }, [supabase])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transaction history</CardTitle>
        <CardDescription>
          Every charge, payout and refund tied to your bets.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : rows === null ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transactions yet.
          </p>
        ) : (
          <>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => gridRef.current?.api.exportDataAsCsv()}
              >
                Export CSV
              </Button>
            </div>
            <AgGridReact<StakeEvent>
              ref={gridRef}
              theme={gridTheme}
              rowData={rows}
              columnDefs={columns}
              defaultColDef={defaultColDef}
              getRowId={({ data }) => data.id}
              domLayout="autoHeight"
              pagination
              paginationPageSize={10}
              paginationPageSizeSelector={false}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
