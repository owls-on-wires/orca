// detail.jsx — Action detail side panel.

function StatusChip({ status }) {
  const label = status.toUpperCase();
  return <span className={`oc-chip oc-chip--${status}`}>{label}</span>;
}

function TypeBadge({ type }) {
  return <span className={`oc-typebadge oc-typebadge--${type}`}>{type}</span>;
}

function Field({ label, children }) {
  return (
    <div className="oc-field">
      <div className="oz-eyebrow oc-field__label">{label}</div>
      <div className="oc-field__value">{children}</div>
    </div>
  );
}

function DetailPanel({ action, fixture }) {
  if (!action) {
    return (
      <aside className="oc-detail oc-detail--empty">
        <div className="oz-eyebrow">No selection</div>
        <p className="oz-mute" style={{ marginTop: 12, fontSize: 13 }}>
          Click any node in the graph to inspect its parameters, output, edges and history.
        </p>
        <div className="oc-detail__legend">
          <div className="oz-eyebrow" style={{ marginBottom: 10 }}>Legend</div>
          <ul className="oc-legend">
            <li><span className="oc-dot" style={{ background: "var(--accent)" }}/> running</li>
            <li><span className="oc-dot" style={{ background: "var(--success)" }}/> completed</li>
            <li><span className="oc-dot" style={{ background: "var(--danger)" }}/> failed</li>
            <li><span className="oc-dot" style={{ background: "var(--gold)" }}/> waiting · escalated</li>
            <li><span className="oc-dot oc-dot--ring"/> pending</li>
          </ul>
        </div>
      </aside>
    );
  }

  const incoming = fixture.edges.filter((e) => e.to === action.id);
  const outgoing = fixture.edges.filter((e) => e.from === action.id);

  return (
    <aside className="oc-detail">
      <header className="oc-detail__head">
        <div className="oc-detail__id-row">
          <code className="oc-detail__id">{action.id}</code>
          <StatusChip status={action.status}/>
        </div>
        <div className="oc-detail__meta-row">
          <TypeBadge type={action.type}/>
          <span className="oz-tiny oz-mute">task:{action.task}</span>
          {action.iter > 0 && <span className="oz-tiny oz-mute">iter {action.iter}</span>}
          {action.turns > 0 && <span className="oz-tiny oz-mute">{action.turns} turns</span>}
          {action.cost > 0 && <span className="oz-tiny oz-mute">${action.cost.toFixed(2)}</span>}
        </div>
      </header>

      {action.summary && action.summary !== "—" && (
        <Field label="Summary">{action.summary}</Field>
      )}
      {action.notes && (
        <Field label="Notes">
          <span className="oz-mute" style={{ fontSize: 13 }}>{action.notes}</span>
        </Field>
      )}

      {action.params && (
        <Field label="Params">
          <div className="oc-params">
            {Object.entries(action.params).map(([k, v]) => (
              <div key={k} className="oc-param">
                <span className="oc-param__k">{k}</span>
                <span className="oc-param__v">{typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : String(v)}</span>
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label={`Edges (${incoming.length} in · ${outgoing.length} out)`}>
        <ul className="oc-edges">
          {incoming.map((e, i) => (
            <li key={"i"+i}><span className="oc-edges__arr">←</span> <code>{e.from}</code> <span className={`oc-edges__cond oc-edges__cond--${e.cond}`}>[{e.cond}]</span></li>
          ))}
          {outgoing.map((e, i) => (
            <li key={"o"+i}><span className="oc-edges__arr">→</span> <code>{e.to}</code> <span className={`oc-edges__cond oc-edges__cond--${e.cond}`}>[{e.cond}]</span></li>
          ))}
          {incoming.length + outgoing.length === 0 && <li className="oz-mute">no edges</li>}
        </ul>
      </Field>

      {action.status === "waiting" && (
        <div className="oc-respond">
          <div className="oz-eyebrow" style={{ marginBottom: 10 }}>Respond</div>
          <textarea className="oc-respond__input" placeholder="Approve, deny, or leave a note for the agent…" rows="3" defaultValue=""/>
          <div className="oc-respond__actions">
            <button className="oz-btn oc-btn">Deny</button>
            <button className="oz-btn oz-btn--primary oc-btn">Approve</button>
          </div>
        </div>
      )}

      {(action.status === "completed" || action.status === "failed") && (
        <Field label="History">
          <ul className="oc-history">
            <li>
              <span className="oc-history__time">11:20 PM</span>
              <span className="oc-history__msg">started · {action.params?.max_turns ? `max ${action.params.max_turns}` : "—"}</span>
            </li>
            <li>
              <span className="oc-history__time">11:21 PM</span>
              <span className="oc-history__msg">{action.turns || 0} turns · ${action.cost.toFixed(2)}</span>
            </li>
            <li>
              <span className="oc-history__time">11:21 PM</span>
              <span className={`oc-history__msg oc-history__msg--${action.status}`}>
                {action.status === "completed" ? "✓ completed" : "× failed"}
              </span>
            </li>
          </ul>
        </Field>
      )}
    </aside>
  );
}

window.OrcaDetail = DetailPanel;
