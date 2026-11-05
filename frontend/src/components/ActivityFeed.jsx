import { useCallback, useEffect, useState } from "react";
import { loc } from "../lib/api";
import { formatPhone, timeAgo } from "../lib/format";
import { Button, EmptyState, Pill, Skeleton } from "./ui";
import { Icon } from "./icons";

const SOURCE = {
  contact: "Customer",
  ghl: "From CRM",
  workflow: "Workflow",
  phone: "Sent from phone",
  auto: "Auto-reply",
};
// Message content is never stored — the feed shows what kind of message moved, not what it said.
const KIND = {
  text: "Message",
  image: "Image",
  video: "Video",
  audio: "Voice note",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contact: "Contact card",
  reaction: "Reaction",
  call: "Call",
  other: "Message",
};
const STATUS_TONE = {
  read: "ok",
  delivered: "ok",
  sent: "neutral",
  pending: "info",
  failed: "err",
};
const STATUS_LABEL = {
  read: "Read",
  delivered: "Delivered",
  sent: "Sent",
  pending: "Sending",
  failed: "Failed",
};

export default function ActivityFeed({
  locationId,
  numbers = [],
  limit = 30,
  refreshKey,
  compact = false,
}) {
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const label = (id) => {
    const n = numbers.find((x) => x.id === id);
    return n ? n.label || formatPhone(n.phoneNumber) : "";
  };

  const load = useCallback(async () => {
    try {
      const r = await loc(locationId).activity({ limit });
      setRows(r);
      setMore(r.length === limit);
    } catch {
      setRows([]);
    }
  }, [locationId, limit]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await loc(locationId).activity({
        limit,
        before: rows[rows.length - 1].at,
      });
      setRows((x) => [...x, ...r]);
      setMore(r.length === limit);
    } finally {
      setLoadingMore(false);
    }
  };

  if (!rows) {
    return (
      <div className="lc-feed-sk" aria-busy="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="row lc-feed-sk-row">
            <Skeleton h={34} w={34} r={10} />
            <div className="grow stack" style={{ gap: 7 }}>
              <Skeleton h={11} w="28%" />
              <Skeleton h={13} w={`${70 - i * 8}%`} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return (
      <EmptyState icon="message" title="No messages yet" flat>
        Messages sent and received on linked numbers show up here, with delivery
        status straight from WhatsApp.
      </EmptyState>
    );
  }

  const groups = [];
  for (const r of rows) {
    const day = dayLabel(r.at);
    if (!groups.length || groups[groups.length - 1].day !== day)
      groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(r);
  }

  return (
    <div className={`af ${compact ? "af-compact" : ""}`}>
      <div className="af-scroll">
        <table className="af-table">
          <thead>
            <tr>
              <th>From / to</th>
              <th>Contact</th>
              <th>Number</th>
              {!compact && <th>Type</th>}
              <th>Status</th>
              {!compact && <th className="af-r">Time</th>}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.day}>
              <tr className="af-day">
                <td colSpan={compact ? 4 : 6}>{g.day}</td>
              </tr>
              {g.items.map((r) => {
                const failed = r.status === "failed";
                const dir = failed
                  ? "fail"
                  : r.direction === "inbound"
                    ? "in"
                    : "out";
                const via = label(r.sessionId);
                const kind =
                  r.kind === "call" && r.preview
                    ? r.preview
                    : KIND[r.kind] || "Message";
                const when = (
                  <span
                    className="af-time"
                    title={r.at ? new Date(r.at).toLocaleString() : undefined}
                  >
                    {timeAgo(r.at)}
                  </span>
                );
                return (
                  <tr
                    key={r.id}
                    className={`af-row ${dir}`}
                    title={r.error || undefined}
                  >
                    <td>
                      <span className="af-who">
                        <span className={`af-dir ${dir}`}>
                          <Icon
                            name={
                              failed
                                ? "alert"
                                : r.direction === "inbound"
                                  ? "arrowIn"
                                  : "arrowOut"
                            }
                            size={12}
                          />
                        </span>
                        <span className="af-who-t">
                          {SOURCE[r.source] || r.source}
                          {compact && <span className="af-sub">{kind}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="tnum af-phone">
                      {r.phone
                        ? formatPhone(r.phone)
                        : r.isGroup
                          ? "Group"
                          : "—"}
                    </td>
                    <td className="af-via">{via || "—"}</td>
                    {!compact && <td className="af-kind">{kind}</td>}
                    <td>
                      <span className="af-status">
                        {r.direction === "outbound" || failed ? (
                          <Pill
                            tone={STATUS_TONE[r.status] || "neutral"}
                            dot={
                              r.status === "read" || r.status === "delivered"
                            }
                          >
                            {STATUS_LABEL[r.status] || r.status}
                          </Pill>
                        ) : (
                          <span className="af-muted">Received</span>
                        )}
                        {compact && when}
                      </span>
                    </td>
                    {!compact && <td className="af-r">{when}</td>}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      {more && (
        <div className="lc-feed-more">
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            loading={loadingMore}
            onClick={loadMore}
          >
            Load older messages
          </Button>
        </div>
      )}
    </div>
  );
}

function dayLabel(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const start = (x) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: diff < 7 ? "long" : undefined,
    day: "numeric",
    month: "short",
  });
}
