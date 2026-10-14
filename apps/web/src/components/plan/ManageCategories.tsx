import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bucket, CategoryDetailView, CategoryGroupView, PlanRow } from "@meridian/shared";
import { Bucket as BucketEnum } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { titleCase } from "../../lib/format.js";
import { moveId, type PlanCategoryRow, type PlanGroupRow } from "../../lib/plan.js";
import { Badge, Card, ErrorText } from "../ui.js";

interface Props {
  /** The unfiltered plan rows: display order, group membership and hidden flags. */
  rows: PlanRow[];
  onClose: () => void;
}

/** A name that turns into an input on "rename". */
function Rename({ name, onSave, disabled }: { name: string; onSave: (name: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (!editing)
    return (
      <>
        <span>{name}</span>
        <button
          type="button"
          className="link small"
          disabled={disabled}
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
        >
          rename
        </button>
      </>
    );
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed && trimmed !== name) onSave(trimmed);
        setEditing(false);
      }}
    >
      <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={100} required />
      <button type="submit" disabled={disabled}>
        Save
      </button>
      <button type="button" className="secondary" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

/**
 * Group and category management for the plan: create groups and categories,
 * rename, reorder with up/down buttons, move a category between groups, hide.
 * Every change invalidates the plan so the grid re-reads its row order.
 */
export function ManageCategories({ rows, onClose }: Props) {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ["category-groups"], queryFn: () => api<CategoryGroupView[]>("/category-groups") });
  const invalidate = () => {
    for (const key of [["plan"], ["categories"], ["category-groups"], ["dashboard"]]) void qc.invalidateQueries({ queryKey: key });
  };
  const createGroup = useMutation({
    mutationFn: (body: { name: string; bucket: Bucket }) => api<CategoryGroupView>("/category-groups", { method: "POST", body }),
    onSuccess: () => {
      setNewGroupName("");
      invalidate();
    },
  });
  const updateGroup = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; hidden?: boolean }) => api<CategoryGroupView>(`/category-groups/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
  const deleteGroup = useMutation({ mutationFn: (id: string) => api<{ ok: true }>(`/category-groups/${id}`, { method: "DELETE" }), onSuccess: invalidate });
  const reorderGroups = useMutation({
    mutationFn: (body: { bucket: Bucket; ids: string[] }) => api<CategoryGroupView[]>("/category-groups/reorder", { method: "POST", body }),
    onSuccess: invalidate,
  });
  const createCategory = useMutation({
    mutationFn: (body: { name: string; bucket: Bucket; groupId?: string }) => api<CategoryDetailView>("/categories", { method: "POST", body }),
    onSuccess: () => {
      setNewCategoryName("");
      invalidate();
    },
  });
  const updateCategory = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; hidden?: boolean; groupId?: string | null }) =>
      api<CategoryDetailView>(`/categories/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
  const reorderCategories = useMutation({
    mutationFn: (body: { groupId: string | null; ids: string[] }) => api<CategoryDetailView[]>("/categories/reorder", { method: "POST", body }),
    onSuccess: invalidate,
  });
  const busy = [createGroup, updateGroup, deleteGroup, reorderGroups, createCategory, updateCategory, reorderCategories].some((m) => m.isPending);
  const errors = [createGroup, updateGroup, deleteGroup, reorderGroups, createCategory, updateCategory, reorderCategories].map((m) => m.error).filter(Boolean);

  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupBucket, setNewGroupBucket] = useState<Bucket>("spending");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryBucket, setNewCategoryBucket] = useState<Bucket>("spending");
  const [newCategoryGroup, setNewCategoryGroup] = useState("");

  const categoryRows = useMemo(() => rows.filter((r): r is PlanCategoryRow => r.kind === "category"), [rows]);
  const groupRows = useMemo(() => rows.filter((r): r is PlanGroupRow => r.kind === "group"), [rows]);
  const groupList = groups.data ?? groupRows.map((g) => ({ id: g.groupId, name: g.name, bucket: g.bucket, position: g.position, hidden: g.hidden, categoryCount: 0 }));

  const categoriesIn = (bucket: Bucket, groupId: string | null) => categoryRows.filter((c) => c.bucket === bucket && c.groupId === groupId);

  const moveCategory = (bucket: Bucket, groupId: string | null, id: string, dir: 1 | -1) => {
    const ids = categoriesIn(bucket, groupId).map((c) => c.categoryId);
    const next = moveId(ids, id, dir);
    if (next.some((v, i) => v !== ids[i])) reorderCategories.mutate({ groupId, ids: next });
  };
  const moveGroup = (bucket: Bucket, id: string, dir: 1 | -1) => {
    const ids = groupList.filter((g) => g.bucket === bucket).map((g) => g.id);
    const next = moveId(ids, id, dir);
    if (next.some((v, i) => v !== ids[i])) reorderGroups.mutate({ bucket, ids: next });
  };

  const renderCategory = (c: PlanCategoryRow, siblings: PlanCategoryRow[], index: number) => (
    <li key={c.categoryId} className={`manage-category ${c.hidden ? "muted" : ""}`}>
      <span className="manage-order">
        <button type="button" className="link" disabled={busy || index === 0} aria-label={`Move ${c.name} up`} onClick={() => moveCategory(c.bucket, c.groupId, c.categoryId, -1)}>
          ↑
        </button>
        <button type="button" className="link" disabled={busy || index === siblings.length - 1} aria-label={`Move ${c.name} down`} onClick={() => moveCategory(c.bucket, c.groupId, c.categoryId, 1)}>
          ↓
        </button>
      </span>
      <span className="manage-name">
        <Rename name={c.name} disabled={busy} onSave={(name) => updateCategory.mutate({ id: c.categoryId, name })} />
        {c.goal && <Badge tone="info">goal</Badge>}
        {c.hidden && <Badge tone="neutral">hidden</Badge>}
      </span>
      <select
        aria-label={`Group for ${c.name}`}
        value={c.groupId ?? ""}
        disabled={busy}
        onChange={(e) => updateCategory.mutate({ id: c.categoryId, groupId: e.target.value === "" ? null : e.target.value })}
      >
        <option value="">— no group —</option>
        {groupList
          .filter((g) => g.bucket === c.bucket)
          .map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
      </select>
      <label className="inline">
        <input type="checkbox" checked={c.hidden} disabled={busy} onChange={(e) => updateCategory.mutate({ id: c.categoryId, hidden: e.target.checked })} /> hidden
      </label>
    </li>
  );

  return (
    <Card
      title="Manage categories"
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Done
        </button>
      }
    >
      {errors.map((e, i) => (
        <ErrorText key={i} error={e} />
      ))}
      <ErrorText error={groups.error} />
      <div className="grid2">
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (newGroupName.trim()) createGroup.mutate({ name: newGroupName.trim(), bucket: newGroupBucket });
          }}
        >
          <input placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} maxLength={100} required />
          <select value={newGroupBucket} onChange={(e) => setNewGroupBucket(e.target.value as Bucket)} aria-label="Bucket for the new group">
            {BucketEnum.options.map((b) => (
              <option key={b} value={b}>
                {titleCase(b)}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy}>
            Add group
          </button>
        </form>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newCategoryName.trim()) return;
            createCategory.mutate({ name: newCategoryName.trim(), bucket: newCategoryBucket, ...(newCategoryGroup ? { groupId: newCategoryGroup } : {}) });
          }}
        >
          <input placeholder="New category name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} maxLength={100} required />
          <select
            value={newCategoryBucket}
            onChange={(e) => {
              setNewCategoryBucket(e.target.value as Bucket);
              setNewCategoryGroup("");
            }}
            aria-label="Bucket for the new category"
          >
            {BucketEnum.options.map((b) => (
              <option key={b} value={b}>
                {titleCase(b)}
              </option>
            ))}
          </select>
          <select value={newCategoryGroup} onChange={(e) => setNewCategoryGroup(e.target.value)} aria-label="Group for the new category">
            <option value="">— no group —</option>
            {groupList
              .filter((g) => g.bucket === newCategoryBucket)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
          <button type="submit" disabled={busy}>
            Add category
          </button>
        </form>
      </div>
      {BucketEnum.options.map((bucket) => {
        const bucketGroups = groupList.filter((g) => g.bucket === bucket);
        const ungrouped = categoriesIn(bucket, null);
        return (
          <section key={bucket} className="manage-bucket">
            <h3>{titleCase(bucket)}</h3>
            {bucketGroups.map((g, gi) => {
              const members = categoriesIn(bucket, g.id);
              return (
                <div key={g.id} className={`manage-group ${g.hidden ? "muted" : ""}`}>
                  <div className="manage-group-head">
                    <span className="manage-order">
                      <button type="button" className="link" disabled={busy || gi === 0} aria-label={`Move group ${g.name} up`} onClick={() => moveGroup(bucket, g.id, -1)}>
                        ↑
                      </button>
                      <button type="button" className="link" disabled={busy || gi === bucketGroups.length - 1} aria-label={`Move group ${g.name} down`} onClick={() => moveGroup(bucket, g.id, 1)}>
                        ↓
                      </button>
                    </span>
                    <strong className="manage-name">
                      <Rename name={g.name} disabled={busy} onSave={(name) => updateGroup.mutate({ id: g.id, name })} />
                      {g.hidden && <Badge tone="neutral">hidden</Badge>}
                    </strong>
                    <label className="inline">
                      <input type="checkbox" checked={g.hidden} disabled={busy} onChange={(e) => updateGroup.mutate({ id: g.id, hidden: e.target.checked })} /> hidden
                    </label>
                    <button
                      type="button"
                      className="link danger small"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete group "${g.name}"? Its categories stay, ungrouped.`)) deleteGroup.mutate(g.id);
                      }}
                    >
                      delete group
                    </button>
                  </div>
                  <ul className="manage-list">{members.map((c, i) => renderCategory(c, members, i))}</ul>
                  {members.length === 0 && <p className="muted small">No categories in this group.</p>}
                </div>
              );
            })}
            <ul className="manage-list">{ungrouped.map((c, i) => renderCategory(c, ungrouped, i))}</ul>
            {bucketGroups.length === 0 && ungrouped.length === 0 && <p className="muted small">No categories yet.</p>}
          </section>
        );
      })}
    </Card>
  );
}
