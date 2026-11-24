"use client";

import { ArrowLeft, ArrowRight, Camera, Check, ImagePlus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { type User } from "@firebase/auth";
import { api, errorText, title, type Asset, type Draft, type Loan, type Profile } from "./lib";

export function Badge({ value }: { value: string }) {
  return <span className={`status ${value}`}><i />{title(value)}</span>;
}

export function Dialog({ title: heading, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="dialog-title">
    <div className="dialog-top"><h2 id="dialog-title">{heading}</h2>
      <button className="icon-button" onClick={close} aria-label="Close dialog"><X size={20} /></button>
    </div>
    <div className="dialog-body">{children}</div>
  </dialog>;
}

export function EquipmentDetails({ asset, profile, user, refresh, notify }: {
  asset: Asset; profile: Profile; user: User; refresh: () => Promise<void>; notify: (message: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = asset.photos[Math.min(index, Math.max(0, asset.photos.length - 1))];
  const staff = profile.role !== "borrower";
  const admin = profile.role === "admin";
  const [action, setAction] = useState<"maintenance" | "repair">();
  const [requested, setRequested] = useState(false);

  async function change(path: string, init: RequestInit, message: string) {
    setProblem(""); setBusy(true);
    try {
      await api(user, path, init);
      await refresh();
      notify(message);
      return true;
    } catch (error) {
      setProblem(errorText(error));
      return false;
    } finally { setBusy(false); }
  }

  function state(value: string, note = "") {
    return change(`/assets/${asset.id}/state`, { method: "POST", body: JSON.stringify({ action: value, note }) }, "Equipment status updated.");
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) { setProblem("Choose a photo first."); return; }
    if (file.size > 3 * 1024 * 1024) { setProblem("Choose a photo under 3 MB."); return; }
    if (await change(`/assets/${asset.id}/photos`, { method: "POST", body: data }, "Photo added.")) form.reset();
  }

  async function book(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = { asset_id: asset.id, starts: data.get("starts"), ends: data.get("ends"), purpose: data.get("purpose") };
    if (await change("/loans", { method: "POST", body: JSON.stringify(body) }, "Request submitted for approval.")) {
      setRequested(true);
    }
  }

  return <div className="stack">
    {problem && <div className="notice error" role="alert">{problem}</div>}
    <div className="gallery">
      {selected ? <img src={selected.url} alt={`${asset.name}, photo ${index + 1}`} referrerPolicy="no-referrer" /> : <div className="photo-empty"><Camera size={34} /><span>No photo uploaded</span></div>}
      {asset.photos.length > 1 && <div className="gallery-controls">
        <button className="icon-button" aria-label="Previous photo" onClick={() => setIndex((index - 1 + asset.photos.length) % asset.photos.length)}><ArrowLeft size={17} /></button>
        <span>{Math.min(index + 1, asset.photos.length)} / {asset.photos.length}</span>
        <button className="icon-button" aria-label="Next photo" onClick={() => setIndex((index + 1) % asset.photos.length)}><ArrowRight size={17} /></button>
      </div>}
    </div>
    <div className="detail-line"><Badge value={asset.status} /><span>{asset.tag} · {asset.location} · {asset.condition}</span></div>
    {asset.description && <p className="muted">{asset.description}</p>}
    {staff && <section className="sub-panel stack">
      <h3>Equipment photos</h3>
      <form className="upload-row" onSubmit={upload}>
        <label><span className="sr-only">Choose an equipment photo</span><input name="file" type="file" accept="image/jpeg,image/png,image/webp" required /></label>
        <button type="submit" className="secondary" disabled={busy || asset.photos.length >= 6}><ImagePlus size={16} /> Upload</button>
      </form>
      <small>JPG, PNG or WebP. Up to 3 MB each. The cover is the first image in the gallery.</small>
      {selected && <div className="inline-actions">
        <button className="secondary" disabled={busy || selected.id === asset.photos[0].id} onClick={async () => {
          if (await change(`/assets/${asset.id}/photos/${selected.id}/cover`, { method: "PUT" }, "Cover photo updated.")) setIndex(0);
        }}>Set as cover</button>
        <button className="secondary danger" disabled={busy || (asset.published && asset.photos.length === 1)} onClick={async () => {
          if (await change(`/assets/${asset.id}/photos/${selected.id}`, { method: "DELETE" }, "Photo removed.")) setIndex(0);
        }}><Trash2 size={15} /> Remove photo</button>
      </div>}
      {admin && <button className="secondary self-start" disabled={busy || (!asset.published && !asset.photos.length)}
        onClick={() => void state(asset.published ? "unpublish" : "publish")}>{asset.published ? "Unpublish equipment" : "Publish equipment"}</button>}
      {!asset.published && !asset.photos.length && <small>Add a photo to make this draft eligible for publishing.</small>}
      {asset.published && asset.status !== "checked_out" && <button className="secondary self-start" disabled={busy}
        onClick={() => setAction(asset.maintenance ? "repair" : "maintenance")}>
        {asset.maintenance ? "Mark repaired" : "Send to maintenance"}
      </button>}
      {action && <form className="stack" onSubmit={async event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (await state(action, String(data.get("note")))) setAction(undefined);
      }}>
        <label>{action === "repair" ? "Repair completed" : "Reason for maintenance"}<textarea name="note" required maxLength={500} /></label>
        <div className="inline-actions"><button className="primary" disabled={busy}>Save note</button>
          <button type="button" className="secondary" onClick={() => setAction(undefined)}>Cancel</button></div>
      </form>}
    </section>}
    {asset.published && !asset.maintenance && !requested && <form className="stack" onSubmit={book}>
      <h3>Request equipment</h3>
      <div className="form-grid">
        <label>Start date<input type="date" name="starts" min={profile.today} defaultValue={profile.today} required /></label>
        <label>Return by<input type="date" name="ends" min={profile.today} defaultValue={profile.today} required /></label>
      </div>
      <label>What do you need it for?<textarea name="purpose" required minLength={3} maxLength={500} placeholder="Describe your intended use" /></label>
      <button className="primary" disabled={busy}>Submit request <ArrowRight size={17} /></button>
    </form>}
    {requested && <div className="notice success"><Check size={16} /> Request submitted. Follow its status in Loans.</div>}
  </div>;
}

export function EditEquipment({ asset, user, saved }: { asset?: Asset; user: User; saved: (id: number) => Promise<void> }) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="stack" onSubmit={async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true); setProblem("");
    try {
      const response = await api<{ id?: number }>(user, asset ? `/assets/${asset.id}` : "/assets", {
        method: asset ? "PATCH" : "POST", body: JSON.stringify(data),
      });
      await saved(asset?.id ?? response.id!);
    } catch (error) { setProblem(errorText(error)); }
    finally { setBusy(false); }
  }}>
    {problem && <div className="notice error" role="alert">{problem}</div>}
    <label>Equipment name<input name="name" defaultValue={asset?.name} minLength={2} maxLength={100} placeholder="Mirrorless camera kit" required /></label>
    <div className="form-grid">
      <label>Asset tag<input name="tag" defaultValue={asset?.tag} maxLength={32} pattern="[A-Za-z0-9\-]+" placeholder="CAM-210" required /></label>
      <label>Category<input name="category" defaultValue={asset?.category} minLength={2} maxLength={60} placeholder="Photography" required /></label>
    </div>
    <label>Location<input name="location" defaultValue={asset?.location} minLength={2} maxLength={80} placeholder="Studio A" required /></label>
    <label>Description<textarea name="description" defaultValue={asset?.description} maxLength={1500} placeholder="What’s included and anything a borrower should know" /></label>
    <button className="primary" disabled={busy}>{busy ? "Saving…" : asset ? "Save equipment" : "Create draft and add photo"} <ArrowRight size={17} /></button>
  </form>;
}

export function LoanDetails({ loan, user, profile, finish }: {
  loan: Loan; user: User; profile: Profile; finish: (message: string) => Promise<void>;
}) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [damaged, setDamaged] = useState(false);
  const [symptom, setSymptom] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const staff = profile.role !== "borrower";
  const actions = [
    ...(staff && loan.status === "pending" ? ["approve", "reject"] : []),
    ...(loan.status === "pending" || loan.status === "approved" ? ["cancel"] : []),
    ...(staff && loan.status === "approved" ? ["checkout"] : []),
    ...(staff && loan.status === "checked_out" ? ["return"] : []),
  ];

  async function act(action: string) {
    setProblem(""); setBusy(true);
    try {
      await api(user, `/loans/${loan.id}/actions`, {
        method: "POST", body: JSON.stringify({ action, note, damaged: action === "return" && damaged }),
      });
      await finish("Loan updated.");
    } catch (error) { setProblem(errorText(error)); }
    finally { setBusy(false); }
  }

  return <div className="stack">
    <div className="detail-line"><Badge value={loan.overdue ? "overdue" : loan.status} /><span>{loan.tag} · {loan.borrower_name}</span></div>
    <dl className="loan-detail">
      <div><dt>Dates</dt><dd>{loan.starts} to {loan.ends}</dd></div>
      <div><dt>Purpose</dt><dd>{loan.purpose}</dd></div>
      {loan.decision_note && <div><dt>Decision note</dt><dd>{loan.decision_note}</dd></div>}
      {loan.return_note && <div><dt>Return note</dt><dd>{loan.return_note}</dd></div>}
    </dl>
    {problem && <div className="notice error" role="alert">{problem}</div>}
    {actions.length > 0 && <label>{actions.includes("return") ? "Return condition and notes" : "Decision note (required to reject)"}
      <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1500} /></label>}
    {actions.includes("return") && <label className="checkbox"><input type="checkbox" checked={damaged}
      onChange={event => { setDamaged(event.target.checked); setDraft(undefined); }} /> Flag equipment for maintenance</label>}
    {damaged && actions.includes("return") && profile.ai_enabled && <div className="sub-panel stack">
      <h3 className="flex items-center gap-2"><Sparkles size={17} /> Draft a maintenance note</h3>
      <label>Observed symptom<textarea value={symptom} maxLength={600}
        placeholder="Charging port is loose and the battery charges intermittently."
        onChange={event => { setSymptom(event.target.value); setDraft(undefined); }} /></label>
      <small>Use equipment symptoms only. This text is sent to Gemini.</small>
      <button className="secondary self-start" disabled={busy || symptom.trim().length < 12} onClick={async () => {
        setBusy(true); setProblem(""); setDraft(undefined);
        try {
          setDraft(await api<Draft>(user, "/ai/repair-draft", { method: "POST", body: JSON.stringify({ symptom }) }));
        } catch (error) { setProblem(errorText(error)); }
        finally { setBusy(false); }
      }}>Generate draft</button>
      {draft && <div className="stack">
        <strong>{draft.category} · {draft.priority} priority</strong><p>{draft.summary}</p><p>{draft.next_step}</p>
        <button className="secondary self-start" onClick={() => {
          setNote(`${draft.category} · ${draft.priority} priority\n${draft.summary}\nSuggested next step: ${draft.next_step}`);
          setDraft(undefined);
        }}>Use draft in editable note</button>
      </div>}
    </div>}
    <div className="inline-actions">{actions.map(action => <button key={action}
      className={["cancel", "reject"].includes(action) ? "secondary danger" : "primary"}
      disabled={busy || (["return", "reject"].includes(action) && !note.trim())}
      onClick={() => void act(action)}>{action === "checkout" ? "Check out" : action === "return" ? "Record return" : title(action)}</button>)}</div>
  </div>;
}
