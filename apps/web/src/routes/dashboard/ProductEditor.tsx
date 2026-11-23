import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CATEGORIES,
  MAX_IMAGES,
  SIZE_SYSTEMS,
  parseCedis,
  productInputSchema,
  variantLabel,
  type ImageDto,
  type ProductDto,
  type ProductInput,
  type SizeSystem,
} from "@kiosk/shared";
import { api, RequestError, uploadImage } from "../../lib/api.ts";
import { prepareImage } from "../../lib/image-prep.ts";
import { useUnsavedGuard } from "../../lib/use-unsaved-guard.ts";
import { Button, Field } from "../../components/ui.tsx";
import { Thumb } from "../../components/Thumb.tsx";
import { Page } from "./Layout.tsx";

/* ───────────── Types & helpers ───────────── */

type Photo = {
  key: string;
  status: "queued" | "uploading" | "done" | "error";
  progress: number;
  image?: ImageDto;
  preview?: string;
  file?: File;
  error?: string;
};

type StockCell = { id?: string; stock: number };
type Form = {
  title: string;
  description: string;
  category: string;
  price: string;
  compareAt: string;
  sizeSystem: SizeSystem;
  sizes: string[];
  colors: string[];
  stock: Record<string, StockCell>;
};

const cellKey = (size: string | null, color: string | null) => `${size ?? ""}|${color ?? ""}`;
const cedisText = (p: number | null) => (p === null ? "" : String(p / 100));
const UPLOAD_CONCURRENCY = 2;

const EMPTY: Form = {
  title: "",
  description: "",
  category: "",
  price: "",
  compareAt: "",
  sizeSystem: "letters",
  sizes: [],
  colors: [],
  stock: {},
};

function formFromProduct(p: ProductDto): Form {
  const sizes = [...new Set(p.variants.map((v) => v.size).filter((s): s is string => Boolean(s)))];
  const colors = [...new Set(p.variants.map((v) => v.color).filter((c): c is string => Boolean(c)))];
  const sizeSystem =
    sizes.length === 0
      ? "oneSize"
      : ((Object.entries(SIZE_SYSTEMS).find(
          ([, sys]) => sys.sizes.length && sizes.every((s) => (sys.sizes as readonly string[]).includes(s)),
        )?.[0] ?? "letters") as SizeSystem);
  const stock: Record<string, StockCell> = {};
  for (const v of p.variants) stock[cellKey(v.size, v.color)] = { id: v.id, stock: v.stock };
  return {
    title: p.title,
    description: p.description ?? "",
    category: p.category,
    price: cedisText(p.pricePesewas),
    compareAt: cedisText(p.compareAtPesewas),
    sizeSystem,
    sizes,
    colors,
    stock,
  };
}

function rowsOf(f: Form) {
  const sizes = f.sizes.length ? f.sizes : [null];
  const colors = f.colors.length ? f.colors : [null];
  return sizes.flatMap((size) => colors.map((color) => ({ size, color, key: cellKey(size, color) })));
}

/** Form + photos -> API payload. Unparseable prices become NaN so validation flags them. */
function toPayload(f: Form, photos: Photo[]): ProductInput {
  const price = parseCedis(f.price);
  const compare = f.compareAt.trim() ? parseCedis(f.compareAt) : null;
  return {
    title: f.title,
    description: f.description || null,
    category: f.category as ProductInput["category"],
    pricePesewas: price ?? Number.NaN,
    compareAtPesewas: f.compareAt.trim() ? (compare ?? Number.NaN) : null,
    variants: rowsOf(f).map((r) => ({
      ...(f.stock[r.key]?.id && { id: f.stock[r.key]!.id }),
      size: r.size,
      color: r.color,
      stock: f.stock[r.key]?.stock ?? 0,
    })),
    imageIds: photos.flatMap((p) => (p.image ? [p.image.id] : [])),
  };
}

/* ───────────── Editor ───────────── */

export function ProductEditor() {
  const { id } = useParams();
  const isNew = !id;
  const q = useQuery({ queryKey: ["product", id], queryFn: () => api.product(id!), enabled: !isNew });

  if (!isNew && q.isPending) return <Page title="Edit product"><div className="h-64 animate-pulse rounded-md bg-sunken" /></Page>;
  if (!isNew && q.isError) {
    return (
      <Page title="Edit product">
        <p className="text-muted">
          {q.error instanceof RequestError && q.error.status === 404 ? "That product doesn't exist." : "The product didn't load. Reload to try again."}
        </p>
      </Page>
    );
  }
  // Remount when the product id changes (e.g. after creating), so state re-seeds cleanly.
  return <EditorForm key={id ?? "new"} product={q.data} />;
}

function EditorForm({ product }: { product?: ProductDto }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => (product ? formFromProduct(product) : EMPTY));
  const [photos, setPhotos] = useState<Photo[]>(() =>
    (product?.images ?? []).map((image) => ({ key: image.id, status: "done", progress: 1, image })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | "save" | "publish" | "status">(null);
  const [notice, setNotice] = useState<string>();
  const [saved, setSaved] = useState(() => JSON.stringify(toPayload(product ? formFromProduct(product) : EMPTY, photos)));

  const payload = useMemo(() => toPayload(form, photos), [form, photos]);
  const uploading = photos.some((p) => p.status === "queued" || p.status === "uploading");
  const dirty = JSON.stringify(payload) !== saved || uploading;
  useUnsavedGuard(dirty && busy === null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k === "price" ? "pricePesewas" : k === "compareAt" ? "compareAtPesewas" : k]: "" }));
    setNotice(undefined);
  };

  /* Photos: queue -> prepare -> upload, at most UPLOAD_CONCURRENCY at once. */
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const active = useRef(0);

  const patchPhoto = (key: string, patch: Partial<Photo>) =>
    setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  useEffect(() => {
    while (active.current < UPLOAD_CONCURRENCY) {
      const next = photosRef.current.find((p) => p.status === "queued");
      if (!next) break;
      active.current++;
      photosRef.current = photosRef.current.map((p) => (p.key === next.key ? { ...p, status: "uploading" } : p));
      patchPhoto(next.key, { status: "uploading", progress: 0, error: undefined });
      (async () => {
        try {
          const blob = await prepareImage(next.file!);
          const image = await uploadImage(blob, (f) => patchPhoto(next.key, { progress: f }));
          patchPhoto(next.key, { status: "done", progress: 1, image });
        } catch (e) {
          patchPhoto(next.key, { status: "error", error: e instanceof RequestError ? e.message : "Upload failed." });
        } finally {
          active.current--;
          setPhotos((ps) => [...ps]); // wake the pump
        }
      })();
    }
  }, [photos]);

  useEffect(() => () => photosRef.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const room = MAX_IMAGES - photos.length;
    const files = [...list].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)).slice(0, room);
    if (list.length > room) setNotice(`Only ${MAX_IMAGES} photos per product. Extra photos were skipped.`);
    setPhotos((ps) => [
      ...ps,
      ...files.map((file) => ({
        key: crypto.randomUUID(),
        status: "queued" as const,
        progress: 0,
        file,
        preview: URL.createObjectURL(file),
      })),
    ]);
    setErrors((e) => ({ ...e, imageIds: "" }));
  }

  function removePhoto(key: string) {
    const p = photos.find((x) => x.key === key);
    if (p?.preview) URL.revokeObjectURL(p.preview);
    // Only unattached uploads are deleted server-side; attached ones go on save.
    if (p?.image && !product?.images.some((i) => i.id === p.image!.id)) void api.discardImage(p.image.id).catch(() => {});
    setPhotos((ps) => ps.filter((x) => x.key !== key));
  }

  function movePhoto(key: string, dir: -1 | 1) {
    setPhotos((ps) => {
      const i = ps.findIndex((p) => p.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ps.length) return ps;
      const next = [...ps];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  /* Save / publish */

  function validate(): ProductInput | null {
    const r = productInputSchema.safeParse(payload);
    if (r.success) return payload;
    const next: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const k = String(issue.path[0]);
      next[k] ??= k === "pricePesewas" && !form.price.trim() ? "Set a price." : k === "pricePesewas" ? "Enter a price like 85 or 85.50." : issue.message;
    }
    setErrors(next);
    return null;
  }

  async function save(): Promise<ProductDto | null> {
    const input = validate();
    if (!input) return null;
    try {
      const saved = product ? await api.updateProduct(product.id, input) : await api.createProduct(input);
      // Adopt server ids for new variants so the next save updates rather than recreates them.
      const ids = new Map(saved.variants.map((v) => [cellKey(v.size, v.color), v.id]));
      const nextForm: Form = {
        ...form,
        stock: Object.fromEntries(rowsOf(form).map((r) => [r.key, { id: ids.get(r.key), stock: form.stock[r.key]?.stock ?? 0 }])),
      };
      setForm(nextForm);
      setSaved(JSON.stringify(toPayload(nextForm, photos)));
      qc.setQueryData(["product", saved.id], saved);
      void qc.invalidateQueries({ queryKey: ["products"] });
      if (!product) navigate(`/dashboard/products/${saved.id}`, { replace: true });
      return saved;
    } catch (e) {
      if (e instanceof RequestError && Object.keys(e.fields).length) setErrors(e.fields);
      else setNotice(e instanceof RequestError ? e.message : "Something went wrong. Try again.");
      return null;
    }
  }

  async function run(kind: "save" | "publish", fn: () => Promise<unknown>) {
    setBusy(kind);
    setNotice(undefined);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(status: "draft" | "active" | "archived") {
    if (!product) return;
    setBusy("status");
    try {
      const p = await api.setProductStatus(product.id, status);
      qc.setQueryData(["product", p.id], p);
      void qc.invalidateQueries({ queryKey: ["products"] });
      if (status === "archived") navigate("/dashboard/products");
    } catch (e) {
      setNotice(e instanceof RequestError ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const status = product?.status ?? "draft";
  const rows = rowsOf(form);
  const totalStock = rows.reduce((n, r) => n + (form.stock[r.key]?.stock ?? 0), 0);

  return (
    <Page title={product ? "Edit product" : "New product"} width="max-w-3xl">
      <div className="space-y-10">
        {/* Photos */}
        <section aria-labelledby="photos-h">
          <SectionHead id="photos-h" title="Photos" note={`${photos.length} of ${MAX_IMAGES}. The first one is the cover.`} />
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3">
            {photos.map((p, i) => (
              <PhotoTile
                key={p.key}
                photo={p}
                index={i}
                count={photos.length}
                onMove={(d) => movePhoto(p.key, d)}
                onRemove={() => removePhoto(p.key)}
                onRetry={() => patchPhoto(p.key, { status: "queued", error: undefined })}
              />
            ))}
            {photos.length < MAX_IMAGES && (
              <li>
                <label className="grid aspect-[4/5] cursor-pointer place-items-center rounded-md border border-dashed border-line-strong bg-raised text-center text-sm text-muted transition-colors hover:border-fg hover:text-fg focus-within:border-fg">
                  <span>
                    <span className="block font-display text-2xl font-bold leading-none text-fg">+</span>
                    Add photos
                  </span>
                  <input
                    type="file"
                    accept="image/*,.heic,.heif"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              </li>
            )}
          </ul>
          {errors.imageIds && <p className="mt-2 text-sm text-danger">{errors.imageIds}</p>}
        </section>

        {/* Details */}
        <section aria-labelledby="details-h" className="space-y-5">
          <SectionHead id="details-h" title="Details" />
          <Field label="Name" placeholder="Vintage Carhartt hoodie" value={form.title} onChange={(e) => set("title", e.target.value)} error={errors.title} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Price"
              prefix="GH₵"
              inputMode="decimal"
              placeholder="85"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              error={errors.pricePesewas}
            />
            <Field
              label="Old price"
              prefix="GH₵"
              inputMode="decimal"
              placeholder="Optional"
              value={form.compareAt}
              onChange={(e) => set("compareAt", e.target.value)}
              error={errors.compareAtPesewas}
              hint="Shows as crossed out, for sales."
            />
          </div>
          <div>
            <label htmlFor="category" className="mb-1.5 block text-sm font-medium">
              Category
            </label>
            <select
              id="category"
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
              aria-invalid={errors.category ? true : undefined}
              className={`h-12 w-full rounded-md border bg-raised px-3 outline-none focus:border-fg ${errors.category ? "border-danger" : "border-line-strong"}`}
            >
              <option value="" disabled>
                Choose one
              </option>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            {errors.category && <p className="mt-1.5 text-sm text-danger">{errors.category}</p>}
          </div>
          <div>
            <label htmlFor="desc" className="mb-1.5 block text-sm font-medium">
              Description
            </label>
            <textarea
              id="desc"
              rows={4}
              maxLength={2000}
              placeholder="Condition, fit, fabric. Anything a buyer would ask you on WhatsApp."
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="w-full rounded-md border border-line-strong bg-raised px-3.5 py-3 outline-none placeholder:text-faint focus:border-fg"
            />
            <p className="mt-1 text-sm text-muted">The WhatsApp assistant uses this to answer questions about the item.</p>
          </div>
        </section>

        {/* Sizes & stock */}
        <section aria-labelledby="stock-h" className="space-y-5">
          <SectionHead id="stock-h" title="Sizes and stock" note={`${totalStock} in stock in total`} />
          <SizePicker form={form} setForm={setForm} />
          <ColorInput colors={form.colors} onChange={(c) => set("colors", c)} />
          <StockGrid rows={rows} stock={form.stock} onChange={(s) => set("stock", s)} />
          {errors.variants && <p className="text-sm text-danger">{errors.variants}</p>}
        </section>
      </div>

      {/* Action bar */}
      <div className="sticky bottom-14 z-10 -mx-5 mt-10 border-t border-line bg-bg/95 px-5 py-3 backdrop-blur-sm sm:bottom-0 sm:-mx-8 sm:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto min-w-0 text-sm">
            {notice ? (
              <p role="alert" className="text-danger">{notice}</p>
            ) : uploading ? (
              <p className="text-muted">Uploading photos…</p>
            ) : dirty ? (
              <p className="text-muted">Unsaved changes</p>
            ) : (
              <p className="text-muted">
                {status === "active" ? "Live in your store" : status === "archived" ? "Archived" : "Draft. Only you can see it."}
              </p>
            )}
          </div>
          {status === "active" ? (
            <>
              <Button variant="quiet" type="button" disabled={busy !== null} onClick={() => setStatus("draft")}>
                Unpublish
              </Button>
              <Button busy={busy === "save"} disabled={!dirty || uploading || busy !== null} onClick={() => run("save", save)}>
                Save changes
              </Button>
            </>
          ) : (
            <>
              {product && (
                <Button variant="quiet" type="button" disabled={busy !== null} onClick={() => setStatus("archived")}>
                  Archive
                </Button>
              )}
              <Button
                variant="secondary"
                busy={busy === "save"}
                disabled={(!dirty && Boolean(product)) || uploading || busy !== null}
                onClick={() => run("save", save)}
              >
                Save draft
              </Button>
              <Button
                busy={busy === "publish"}
                disabled={uploading || busy !== null}
                onClick={() =>
                  run("publish", async () => {
                    const p = dirty || !product ? await save() : product;
                    if (p) {
                      const live = await api.setProductStatus(p.id, "active").catch((e: unknown) => {
                        setNotice(e instanceof RequestError ? e.message : "Couldn't publish.");
                        return null;
                      });
                      if (live) {
                        qc.setQueryData(["product", live.id], live);
                        void qc.invalidateQueries({ queryKey: ["products"] });
                      }
                    }
                  })
                }
              >
                Publish
              </Button>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

/* ───────────── Pieces ───────────── */

function SectionHead({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4 border-b border-line pb-2">
      <h2 id={id} className="font-display text-lg font-bold tracking-[-0.01em]">
        {title}
      </h2>
      {note && <p className="text-sm text-muted">{note}</p>}
    </div>
  );
}

function PhotoTile({
  photo,
  index,
  count,
  onMove,
  onRemove,
  onRetry,
}: {
  photo: Photo;
  index: number;
  count: number;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const ctl =
    "grid size-8 place-items-center rounded-full bg-ink/80 text-[color:var(--chalk)] text-sm hover:bg-ink disabled:opacity-0";
  return (
    <li className="group relative aspect-[4/5] overflow-hidden rounded-md bg-sunken">
      {photo.image ? (
        <Thumb image={photo.image} sizes="(min-width: 640px) 180px, 33vw" className="size-full" />
      ) : photo.preview ? (
        <img src={photo.preview} alt="" className="size-full object-cover opacity-60" />
      ) : null}

      {index === 0 && (
        <span className="absolute left-2 top-2 rounded-full bg-gold px-2 py-0.5 text-xs font-medium text-ink">Cover</span>
      )}

      {(photo.status === "uploading" || photo.status === "queued") && (
        <div className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-ink/20" aria-label="Uploading">
          <div
            className="h-full bg-ink transition-[width] duration-200"
            style={{ width: `${Math.max(6, Math.round(photo.progress * 100))}%` }}
          />
        </div>
      )}

      {photo.status === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-bg/85 p-2 text-center">
          <div>
            <p className="text-xs text-danger">{photo.error}</p>
            <div className="mt-2 flex justify-center gap-3 text-sm">
              <button type="button" onClick={onRetry} className="font-medium underline underline-offset-4">
                Retry
              </button>
              <button type="button" onClick={onRemove} className="text-muted underline underline-offset-4">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {photo.status === "done" && (
        <div className="absolute inset-x-1.5 bottom-1.5 flex justify-between opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <div className="flex gap-1">
            <button type="button" className={ctl} disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move earlier">
              ‹
            </button>
            <button type="button" className={ctl} disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move later">
              ›
            </button>
          </div>
          <button type="button" className={ctl} onClick={onRemove} aria-label="Remove photo">
            ×
          </button>
        </div>
      )}
    </li>
  );
}

function SizePicker({ form, setForm }: { form: Form; setForm: React.Dispatch<React.SetStateAction<Form>> }) {
  const [custom, setCustom] = useState("");
  const preset = SIZE_SYSTEMS[form.sizeSystem].sizes as readonly string[];
  const extras = form.sizes.filter((s) => !preset.includes(s));

  const order = (sizes: string[]) =>
    [...sizes].sort((a, b) => {
      const ia = preset.indexOf(a);
      const ib = preset.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

  const toggle = (s: string) =>
    setForm((f) => ({ ...f, sizes: f.sizes.includes(s) ? f.sizes.filter((x) => x !== s) : order([...f.sizes, s]) }));

  const switchSystem = (sys: SizeSystem) => {
    if (sys === form.sizeSystem) return;
    if (form.sizes.length && !window.confirm("Switching clears the sizes you picked. Continue?")) return;
    setForm((f) => ({ ...f, sizeSystem: sys, sizes: [] }));
  };

  const addCustom = () => {
    const v = custom.trim().slice(0, 20);
    if (v && !form.sizes.some((s) => s.toLowerCase() === v.toLowerCase())) setForm((f) => ({ ...f, sizes: order([...f.sizes, v]) }));
    setCustom("");
  };

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Size type" className="inline-flex rounded-md border border-line-strong p-0.5">
        {(Object.keys(SIZE_SYSTEMS) as SizeSystem[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={form.sizeSystem === k}
            onClick={() => switchSystem(k)}
            className={`rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm transition-colors ${
              form.sizeSystem === k ? "bg-ink text-[color:var(--chalk)]" : "text-muted hover:text-fg"
            }`}
          >
            {SIZE_SYSTEMS[k].label}
          </button>
        ))}
      </div>

      {form.sizeSystem !== "oneSize" && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Sizes you have">
          {[...preset, ...extras].map((s) => {
            const on = form.sizes.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(s)}
                className={`h-10 min-w-12 rounded-md border px-3 text-[15px] tabular-nums transition-colors ${
                  on ? "border-ink bg-ink text-[color:var(--chalk)]" : "border-line-strong bg-raised hover:border-fg"
                }`}
              >
                {s}
              </button>
            );
          })}
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())}
            onBlur={addCustom}
            placeholder="Other size"
            aria-label="Add another size"
            className="h-10 w-28 rounded-md border border-dashed border-line-strong bg-transparent px-3 text-[15px] outline-none placeholder:text-faint focus:border-fg"
          />
        </div>
      )}
    </div>
  );
}

function ColorInput({ colors, onChange }: { colors: string[]; onChange: (c: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((c) => c.trim().slice(0, 30)).filter(Boolean);
    const next = [...colors];
    for (const p of parts) if (!next.some((c) => c.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !draft && colors.length) onChange(colors.slice(0, -1));
  };
  return (
    <div>
      <label htmlFor="colors" className="mb-1.5 block text-sm font-medium">
        Colours <span className="font-normal text-muted">(optional)</span>
      </label>
      <div className="flex min-h-12 flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2 py-1.5 focus-within:border-fg">
        {colors.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-full bg-sunken py-1 pl-3 pr-1.5 text-sm">
            {c}
            <button
              type="button"
              onClick={() => onChange(colors.filter((x) => x !== c))}
              aria-label={`Remove ${c}`}
              className="grid size-5 place-items-center rounded-full text-muted hover:bg-line hover:text-fg"
            >
              ×
            </button>
          </span>
        ))}
        <input
          id="colors"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={add}
          placeholder={colors.length ? "" : "Black, Cream"}
          className="h-8 min-w-24 flex-1 bg-transparent px-1.5 outline-none placeholder:text-faint"
        />
      </div>
      <p className="mt-1.5 text-sm text-muted">Only if you have the same item in different colours.</p>
    </div>
  );
}

function StockGrid({
  rows,
  stock,
  onChange,
}: {
  rows: { size: string | null; color: string | null; key: string }[];
  stock: Record<string, StockCell>;
  onChange: (s: Record<string, StockCell>) => void;
}) {
  const [fill, setFill] = useState("");
  const setOne = (key: string, n: number) =>
    onChange({ ...stock, [key]: { ...stock[key], stock: Math.max(0, Math.min(9999, Math.round(n) || 0)) } });
  const setAll = () => {
    const n = Number.parseInt(fill, 10);
    if (Number.isNaN(n)) return;
    const next = { ...stock };
    for (const r of rows) next[r.key] = { ...next[r.key], stock: Math.max(0, Math.min(9999, n)) };
    onChange(next);
    setFill("");
  };
  const step = "grid size-10 place-items-center rounded-md text-lg text-muted hover:bg-sunken hover:text-fg";

  return (
    <div>
      {rows.length > 1 && (
        <div className="mb-2 flex items-center justify-end gap-2 text-sm">
          <label htmlFor="fill-all" className="text-muted">
            Set all to
          </label>
          <input
            id="fill-all"
            inputMode="numeric"
            value={fill}
            onChange={(e) => setFill(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && setAll()}
            className="h-9 w-16 rounded-md border border-line-strong bg-raised text-center tabular-nums outline-none focus:border-fg"
          />
          <Button variant="quiet" type="button" onClick={setAll}>
            Apply
          </Button>
        </div>
      )}
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((r) => {
          const n = stock[r.key]?.stock ?? 0;
          return (
            <li key={r.key} className="flex items-center justify-between gap-4 py-1.5">
              <span className={`text-[15px] ${n === 0 ? "text-muted" : ""}`}>
                {variantLabel(r)}
                {n === 0 && <span className="ml-2 text-sm text-danger">Sold out</span>}
              </span>
              <div className="flex items-center gap-1">
                <button type="button" className={step} onClick={() => setOne(r.key, n - 1)} aria-label={`One fewer ${variantLabel(r)}`}>
                  −
                </button>
                <input
                  inputMode="numeric"
                  value={n}
                  onChange={(e) => setOne(r.key, Number(e.target.value.replace(/\D/g, "")))}
                  onFocus={(e) => e.target.select()}
                  aria-label={`Stock for ${variantLabel(r)}`}
                  className="h-10 w-14 rounded-md border border-line-strong bg-raised text-center font-display font-bold tabular-nums outline-none focus:border-fg"
                />
                <button type="button" className={step} onClick={() => setOne(r.key, n + 1)} aria-label={`One more ${variantLabel(r)}`}>
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

