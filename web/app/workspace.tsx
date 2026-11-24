"use client";

import {
  Activity as ActivityIcon, ArrowDownToLine, ArrowDownRight, ArrowRight, ArrowUpRight, Box, CalendarDays,
  Camera, CircleAlert, ClipboardList, Grid2X2, LoaderCircle, LogOut, PackageCheck, Plus, Search, Users, Wrench,
} from "lucide-react";
import { signOut, type Auth, type User } from "@firebase/auth";
import { useCallback, useEffect, useState } from "react";
import { Badge, Dialog, EditEquipment, EquipmentDetails, LoanDetails } from "./dialogs";
import {
  api, dateLabel, errorText, title, type Activity, type Asset, type Loan, type Member, type Page, type Profile, type Stats,
} from "./lib";
import { Brand } from "./sign-in";

const tabs = [
  { name: "Overview", icon: Grid2X2 }, { name: "Equipment", icon: Box },
  { name: "Loans", icon: ClipboardList }, { name: "Activity", icon: ActivityIcon },
  { name: "Members", icon: Users },
] as const;
type Tab = typeof tabs[number]["name"];
type View = { kind: "equipment"; asset: Asset } | { kind: "edit"; asset?: Asset } | { kind: "loan"; loan: Loan };

function AssetCard({ asset, open }: { asset: Asset; open: () => void }) {
  return <button className="asset-card" onClick={open}>
    <div className="asset-cover">
      {asset.photos[0] ? <img src={asset.photos[0].url} alt="" loading="lazy" referrerPolicy="no-referrer" />
        : <div className="photo-empty"><Camera size={28} /><span>Awaiting photo</span></div>}
      <Badge value={asset.status} />
    </div>
    <div className="asset-info">
      <div><small>{asset.tag} · {asset.category}</small><h3>{asset.name}</h3><p>{asset.location}</p></div>
      <ArrowUpRight size={19} aria-hidden />
    </div>
  </button>;
}

function Empty({ title: heading, message }: { title: string; message: string }) {
  return <div className="empty"><Box size={25} /><h3>{heading}</h3><p>{message}</p></div>;
}

function Pager({ offset, more, setOffset }: { offset: number; more: boolean; setOffset: (value: number) => void }) {
  if (!more && offset === 0) return null;
  return <div className="pager">
    <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
    <span>Page {Math.floor(offset / 50) + 1}</span>
    <button className="secondary" disabled={!more} onClick={() => setOffset(offset + 50)}>Next</button>
  </div>;
}

export function Workspace({ auth, user }: { auth: Auth; user: User }) {
  const [profile, setProfile] = useState<Profile>();
  const [tab, setTab] = useState<Tab>("Overview");
  const [assetPage, setAssets] = useState<Page<Asset>>({ items: [], more: false });
  const [loanPage, setLoans] = useState<Page<Loan>>({ items: [], more: false });
  const [activityPage, setActivity] = useState<Page<Activity>>({ items: [], more: false });
  const [memberPage, setMembers] = useState<Page<Member>>({ items: [], more: false });
  const [stats, setStats] = useState<Stats>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState(true);
  const [fetchIssue, setFetchIssue] = useState("");
  const [toast, setToast] = useState("");
  const [actionIssue, setActionIssue] = useState("");
  const [changingRole, setChangingRole] = useState<string>();
  const staff = profile?.role === "staff" || profile?.role === "admin";
  const admin = profile?.role === "admin";

  const loadProfile = useCallback(async () => setProfile(await api<Profile>(user, "/me")), [user]);
  const loadData = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ offset: String(offset), search: search.trim(), status: filter });
    const config = { signal };
    if (tab === "Overview") {
      const [counts, assets, loans] = await Promise.all([
        api<Stats>(user, "/assets/stats", config),
        api<Page<Asset>>(user, "/assets", config),
        api<Page<Loan>>(user, "/loans", config),
      ]);
      if (!signal?.aborted) { setStats(counts); setAssets(assets); setLoans(loans); }
    } else if (tab === "Equipment") {
      const data = await api<Page<Asset>>(user, "/assets?" + params, config);
      if (!signal?.aborted) setAssets(data);
    } else if (tab === "Loans") {
      const data = await api<Page<Loan>>(user, "/loans?" + params, config);
      if (!signal?.aborted) setLoans(data);
    } else if (tab === "Activity") {
      const data = await api<Page<Activity>>(user, "/activity?" + params, config);
      if (!signal?.aborted) setActivity(data);
    } else {
      const data = await api<Page<Member>>(user, "/members?" + params, config);
      if (!signal?.aborted) setMembers(data);
    }
  }, [user, tab, search, filter, offset]);

  useEffect(() => {
    loadProfile().catch(error => setFetchIssue(errorText(error)));
  }, [loadProfile]);

  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController();
    setBusy(true); setFetchIssue("");
    const id = window.setTimeout(() => loadData(controller.signal)
      .catch(error => { if (!controller.signal.aborted) setFetchIssue(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); }), search ? 250 : 0);
    return () => { window.clearTimeout(id); controller.abort(); };
  }, [loadData, profile, search]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(id);
  }, [toast]);

  function navigate(next: Tab, nextFilter = "") {
    setBusy(true); setSearch(""); setFilter(nextFilter); setOffset(0); setActionIssue("");
    if (next === tab && nextFilter === filter && !search && offset === 0) {
      void loadData().catch(error => setFetchIssue(errorText(error))).finally(() => setBusy(false));
    }
    setTab(next);
  }

  async function refreshAsset(id: number) {
    const asset = await api<Asset>(user, `/assets/${id}`);
    setView({ kind: "equipment", asset });
    await loadData();
  }

  async function exportCsv() {
    setActionIssue("");
    try {
      const blob = await api<Blob>(user, "/loans/export");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "assetflow-loans.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setActionIssue(errorText(error)); }
  }

  if (!profile) return <main className="boot"><Brand />
    {fetchIssue ? <>
      <div className="notice error" role="alert">{fetchIssue}</div>
      <div className="inline-actions"><button className="secondary" onClick={() => {
        setFetchIssue(""); void loadProfile().catch(error => setFetchIssue(errorText(error)));
      }}>Retry</button><button className="secondary" onClick={() => void signOut(auth)}>Sign out</button></div>
    </> : <p role="status">Connecting to your workspace…</p>}
  </main>;

  const metrics = [
    { label: "In inventory", value: stats?.total, icon: Box, accent: "teal", hint: "Published equipment", click: () => navigate("Equipment") },
    { label: "Available today", value: stats?.available, icon: PackageCheck, accent: "green", hint: "Ready to request", click: () => navigate("Equipment", "available") },
    { label: "Checked out", value: stats?.checked_out, icon: ArrowUpRight, accent: "indigo", hint: "Currently on loan", click: () => navigate("Equipment", "checked_out") },
    { label: "Overdue loans", value: stats?.overdue, icon: CircleAlert, accent: "amber", hint: staff ? "Past their return date" : "Your late returns", click: () => navigate("Loans", "overdue") },
  ];
  const headings: Record<Tab, string> = {
    Overview: "Workspace overview", Equipment: "Equipment catalog", Loans: staff ? "Loans & requests" : "My loans",
    Activity: "Activity history", Members: "Workspace members",
  };

  function loanTable(items: Loan[]) {
    return !items.length ? <Empty title="No loans here" message="Approved reservations and new requests appear here as soon as they’re submitted." />
      : <div className="table-wrap"><table>
        <thead><tr><th>Equipment</th>{staff && <th>Borrower</th>}<th>Dates</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{items.map(loan => <tr key={loan.id}>
          <td><strong>{loan.asset_name}</strong><small>{loan.tag}</small></td>
          {staff && <td>{loan.borrower_name}</td>}
          <td>{dateLabel(loan.starts)} – {dateLabel(loan.ends)}</td>
          <td><Badge value={loan.overdue ? "overdue" : loan.status} /></td>
          <td><button className="text-button" onClick={() => setView({ kind: "loan", loan })}>View <ArrowRight size={14} /></button></td>
        </tr>)}</tbody>
      </table></div>;
  }

  return <div className="shell">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Workspace">{tabs.filter(item => item.name !== "Members" || admin).map(({ name, icon: Icon }) =>
        <button key={name} className={tab === name ? "selected" : ""} aria-current={tab === name ? "page" : undefined}
          onClick={() => navigate(name)}><Icon size={19} />{name}</button>)}</nav>
      <div className="side-bottom">
        <div className="account"><span className="avatar">{profile.name.slice(0, 2).toUpperCase()}</span>
          <div><strong>{profile.name}</strong><small>{title(profile.role)}</small></div>
          <button className="icon-button" aria-label="Sign out" onClick={() => void signOut(auth).catch(error => setActionIssue(errorText(error)))}><LogOut size={18} /></button>
        </div>
      </div>
    </aside>

    <main className="workspace">
      <div className="topline"><span>Workspace <span className="slash">/</span> {tab}</span><span className="today"><CalendarDays size={16} /> {dateLabel(profile.today)}</span></div>
      <div className="content">
        <header className="page-heading">
          <div><h1>{headings[tab]}</h1><p>{tab === "Overview" ? "Track equipment, reservations, and returns in one place."
            : tab === "Equipment" ? "Browse equipment by name, asset tag, category, or location."
            : tab === "Loans" ? "Review requests and track the status of each loan."
            : tab === "Members" ? "Manage staff access for verified accounts."
            : "Review lending and inventory updates."}</p></div>
          {admin && (tab === "Overview" || tab === "Equipment") &&
            <button className="primary" onClick={() => setView({ kind: "edit" })}><Plus size={18} /> Add equipment</button>}
          {staff && tab === "Loans" && <button className="secondary" onClick={() => void exportCsv()}><ArrowDownToLine size={17} /> Export CSV</button>}
        </header>

        {(fetchIssue || actionIssue) && <div className="notice error" role="alert">
          {fetchIssue || actionIssue}
          {fetchIssue && <button className="text-button" onClick={() => {
            setFetchIssue(""); void loadData().catch(error => setFetchIssue(errorText(error)));
          }}>Retry</button>}
        </div>}
        {toast && <div className="toast" role="status"><PackageCheck size={19} />{toast}</div>}

        {tab === "Overview" && <>
          <div className="metrics">{metrics.map(({ label, value, icon: Icon, accent, hint, click }) =>
            <button className="metric" key={label} onClick={click}>
              <div><span className={`metric-icon ${accent}`}><Icon size={19} /></span><ArrowUpRight size={16} className="muted" /></div>
              <strong>{value ?? "–"}</strong><span>{label}</span><small>{hint}</small>
            </button>)}</div>
          <div className="attention"><span><Wrench size={18} /> {stats?.maintenance ?? "–"} in maintenance</span>
            <span><CalendarDays size={18} /> {stats?.reserved ?? "–"} reserved today</span>
            <button className="text-button" onClick={() => navigate("Loans", "pending")}><ArrowDownRight size={17} /> {stats?.pending ?? "–"} pending requests</button>
          </div>
          <section className="group">
            <div className="section-title"><h2>Equipment</h2><button className="text-button" onClick={() => navigate("Equipment")}>View catalog <ArrowRight size={16} /></button></div>
            {busy ? <Loading /> : assetPage.items.length ? <div className="inventory-grid">{assetPage.items.slice(0, 3).map(asset =>
              <AssetCard key={asset.id} asset={asset} open={() => setView({ kind: "equipment", asset })} />)}</div>
              : <Empty title="No equipment yet" message={admin ? "Add your first item, then upload a photo to publish it." : "Published equipment will appear here."} />}
          </section>
          <section className="group"><div className="section-title"><h2>Recent loans</h2><button className="text-button" onClick={() => navigate("Loans")}>View loans <ArrowRight size={16} /></button></div>
            {busy ? <Loading /> : loanTable(loanPage.items.slice(0, 5))}
          </section>
        </>}

        {tab === "Equipment" && <section className="group">
          <div className="toolbar">
            <label className="search"><Search size={17} /><span className="sr-only">Search equipment</span>
              <input type="search" value={search} maxLength={100} placeholder="Search equipment…" onChange={event => { setOffset(0); setSearch(event.target.value); }} /></label>
            <label><span className="sr-only">Equipment status</span><select value={filter} onChange={event => { setOffset(0); setFilter(event.target.value); }}>
              <option value="">All statuses</option>{["available", "reserved", "checked_out", "maintenance", ...(staff ? ["draft"] : [])].map(value => <option key={value} value={value}>{title(value)}</option>)}
            </select></label>
          </div>
          {busy ? <Loading /> : assetPage.items.length ? <div className="inventory-grid">{assetPage.items.map(asset =>
            <AssetCard key={asset.id} asset={asset} open={() => setView({ kind: "equipment", asset })} />)}</div>
            : <Empty title="No matching equipment" message={search || filter ? "Try another search or status." : "Equipment will appear here once added to the workspace."} />}
          {!busy && <Pager offset={offset} more={assetPage.more} setOffset={setOffset} />}
        </section>}

        {tab === "Loans" && <section className="group">
          <div className="toolbar"><label><span className="sr-only">Loan status</span><select value={filter} onChange={event => { setOffset(0); setFilter(event.target.value); }}>
            <option value="">All statuses</option>{["pending", "approved", "rejected", "checked_out", "overdue", "returned", "cancelled"].map(value => <option key={value} value={value}>{title(value)}</option>)}
          </select></label></div>
          {busy ? <Loading /> : <>{loanTable(loanPage.items)}<Pager offset={offset} more={loanPage.more} setOffset={setOffset} /></>}
        </section>}

        {tab === "Activity" && <section className="group">{busy ? <Loading /> : activityPage.items.length
          ? <ul className="activity-list">{activityPage.items.map(item => <li key={item.id}>
            <span className="metric-icon teal"><ActivityIcon size={17} /></span>
            <div><strong>{title(item.action)}{item.asset_name && ` · ${item.asset_name}`}</strong>
              <small>{item.actor} · {new Date(item.created_at).toLocaleString()}</small>{item.detail && <p>{item.detail}</p>}</div>
          </li>)}</ul> : <Empty title="No activity yet" message="Lending events appear here as people use the workspace." />}
          {!busy && <Pager offset={offset} more={activityPage.more} setOffset={setOffset} />}
        </section>}

        {tab === "Members" && <section className="group">
          <div className="toolbar"><label className="search"><Search size={17} /><span className="sr-only">Search members</span>
            <input type="search" value={search} maxLength={100} placeholder="Search name or email…" onChange={event => { setOffset(0); setSearch(event.target.value); }} /></label></div>
          {busy ? <Loading /> : memberPage.items.length ? <div className="table-wrap"><table>
            <thead><tr><th>Member</th><th>Role</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>{memberPage.items.map(member => <tr key={member.uid}><td><strong>{member.name}</strong><small>{member.email}</small></td>
              <td>{title(member.role)}</td><td>{member.role !== "admin" && <button className="secondary" disabled={Boolean(changingRole)} onClick={async () => {
                setChangingRole(member.uid); setActionIssue("");
                try {
                  await api(user, `/members/${encodeURIComponent(member.uid)}/role`, { method: "PATCH", body: JSON.stringify({ role: member.role === "staff" ? "borrower" : "staff" }) });
                  setToast("Member role updated.");
                  await loadData();
                } catch (error) { setActionIssue(errorText(error)); } finally { setChangingRole(undefined); }
              }}>{changingRole === member.uid ? "Saving…" : member.role === "staff" ? "Remove staff access" : "Grant staff access"}</button>}</td>
            </tr>)}</tbody>
          </table></div> : <Empty title="No matching members" message="Accounts appear here after verified users sign in." />}
          {!busy && <Pager offset={offset} more={memberPage.more} setOffset={setOffset} />}
        </section>}
      </div>
    </main>

    {view && <Dialog close={() => setView(undefined)} title={view.kind === "loan" ? view.loan.asset_name
      : view.kind === "edit" ? view.asset ? "Edit equipment" : "Add equipment" : view.asset.name}>
      {view.kind === "edit" && <EditEquipment asset={view.asset} user={user} saved={async id => {
        setToast(view.asset ? "Equipment updated." : "Draft saved. Add a photo to publish.");
        await refreshAsset(id);
      }} />}
      {view.kind === "equipment" && <>
        {admin && <button className="text-button edit-link" onClick={() => setView({ kind: "edit", asset: view.asset })}>Edit equipment</button>}
        <EquipmentDetails key={view.asset.id} asset={view.asset} profile={profile} user={user}
          refresh={() => refreshAsset(view.asset.id)} notify={setToast} />
      </>}
      {view.kind === "loan" && <LoanDetails key={view.loan.id} loan={view.loan} profile={profile} user={user} finish={async message => {
        setView(undefined); setToast(message);
        try { await loadData(); } catch (error) { setFetchIssue(errorText(error)); }
      }} />}
    </Dialog>}
  </div>;
}

function Loading() {
  return <div className="loading" role="status"><LoaderCircle size={19} className="animate-spin" /> Loading…</div>;
}
