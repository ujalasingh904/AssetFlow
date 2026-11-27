"use client";

import { title, type Role } from "./lib";

const statuses = ["pending", "approved", "checked_out", "overdue", "returned", "rejected", "cancelled"];
const loanEvents = ["request_submitted", "approve", "reject", "cancel", "checkout", "return", "damaged_return"];
const inventoryEvents = ["equipment_created", "equipment_updated", "publish", "unpublish", "maintenance", "repair", "photo_added", "photo_removed", "cover_changed"];

export function RecordFilters({ activity, role, initialStatus, apply }: {
  activity: boolean; role: Role; initialStatus: string; apply: (query: string) => void;
}) {
  const actions = [...loanEvents, ...(role !== "borrower" ? inventoryEvents : []), ...(role === "admin" ? ["role_updated"] : [])];
  return <form className="record-filters" aria-label={activity ? "Activity filters" : "Loan filters"}
    onSubmit={event => {
      event.preventDefault();
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(event.currentTarget)) {
        if (typeof value === "string" && value.trim()) params.set(key, value.trim());
      }
      apply(params.toString());
    }}>
    <label>{activity ? "Event from (UTC)" : "Reservation from"}<input type="date" name="date_from" onChange={event => {
      const end = event.currentTarget.form?.elements.namedItem("date_to") as HTMLInputElement | null;
      if (end) end.min = event.currentTarget.value;
    }} /></label>
    <label>{activity ? "Event through (UTC)" : "Reservation through"}<input type="date" name="date_to" /></label>
    <label>Equipment<input name="equipment" maxLength={100} placeholder="Name or asset tag" /></label>
    {role !== "borrower" && <label>{activity ? "Member who acted" : "Borrower"}<input name={activity ? "member" : "borrower"} maxLength={100} placeholder="Name or email" /></label>}
    <label>Loan ID<input name="loan_id" type="number" min="1" step="1" placeholder="e.g. 42" /></label>
    <label>{activity ? "Event type" : "Loan status"}<select name={activity ? "action" : "status"} defaultValue={activity ? "" : initialStatus}>
      <option value="">{activity ? "All events" : "All statuses"}</option>
      {(activity ? actions : statuses).map(value => <option key={value} value={value}>{title(value)}</option>)}
    </select></label>
    <div className="inline-actions"><button type="submit" className="primary">Apply filters</button>
      <button type="button" className="secondary" onClick={event => {
        const form = event.currentTarget.form!;
        form.reset();
        (form.elements.namedItem("date_to") as HTMLInputElement).min = "";
        (form.querySelector("select") as HTMLSelectElement).value = "";
        apply("");
      }}>Clear</button></div>
  </form>;
}
