import { Link } from "react-router";
import type { DashboardView } from "@meridian/shared";
import { relativeTime } from "../../lib/format.js";
import { Badge, Card } from "../ui.js";
import { syncStatusText, syncTone } from "./dashboard.js";

/** When the banks were last read, and the connections that need a person. */
export function SyncCard({ sync }: { sync: DashboardView["sync"] }) {
  return (
    <Card title="Sync" actions={<Link to="/connections">Connections</Link>}>
      <p className="dash-sub">
        Last sync <strong>{relativeTime(sync.lastSyncAt)}</strong>
        {sync.lastSyncAt && <span className="muted small"> ({new Date(sync.lastSyncAt).toLocaleString()})</span>}
      </p>
      {sync.attention.length === 0 ? (
        <p className="muted small">Every connection is healthy.</p>
      ) : (
        <ul className="dash-review">
          {sync.attention.map((c) => (
            <li key={c.connectionId}>
              <Link to="/connections">{c.name}</Link>
              <Badge tone={syncTone(c.status)}>{syncStatusText(c.status)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
