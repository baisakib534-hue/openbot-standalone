import { IconPlus, IconStar, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  addProvider,
  providerKeys,
  type ProviderRow,
  providersQueryOptions,
  providerSourceLabel,
  removeProvider,
  setDefaultProvider,
  suggestProviderId,
} from "@/lib/providers/api";

export const Route = createFileRoute("/_authed/admin/providers")({
  component: ProvidersPage,
});

/** A small chip in theme colours — the same shape the audit and skills pages use for state. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function DefaultChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      <IconStar className="size-3" />
      Default
    </span>
  );
}

function ProvidersPage() {
  const queryClient = useQueryClient();
  const providers = useQuery(providersQueryOptions());
  const [adding, setAdding] = useState(false);
  const [defaultFor, setDefaultFor] = useState<ProviderRow | null>(null);
  const [deleting, setDeleting] = useState<ProviderRow | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: providerKeys.providers });

  const setDefault = useMutation({
    mutationFn: (input: { provider: string; model?: string }) =>
      setDefaultProvider(input.provider, input.model),
    onSuccess: async () => {
      await invalidate();
      setDefaultFor(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeProvider(id),
    onSuccess: async () => {
      await invalidate();
      setDeleting(null);
    },
  });

  const rows = providers.data?.providers ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          Add provider
        </Button>
      }
      description="The model providers this deployment can run on. One of them is the default every built-in Bot uses. Keys are write-only: OpenBot never displays a key once saved, and replacing one means editing the provider with a new key. New providers and default changes apply from the next server start."
      title="Providers"
    >
      {providers.isPending ? (
        <PageEmpty>Loading providers…</PageEmpty>
      ) : providers.isError ? (
        <PageEmpty>Could not load providers.</PageEmpty>
      ) : rows.length === 0 ? (
        <PageEmpty>No providers are registered yet.</PageEmpty>
      ) : (
        <PageRows>
          {rows.map((row) => (
            <Item key={row.id}>
              <ItemContent>
                <ItemTitle>
                  <span className="flex items-center gap-2">
                    {row.label}
                    {row.isDefault ? <DefaultChip /> : null}
                    <Chip>{providerSourceLabel(row.source)}</Chip>
                    <Chip>{row.keyPresent ? "Key set" : "No key"}</Chip>
                  </span>
                </ItemTitle>
                <ItemDescription>
                  {row.id}
                  {row.baseUrl ? ` · ${row.baseUrl}` : ""}
                  {` · default model ${row.defaultModel}`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {!row.isDefault ? (
                  <Button
                    onClick={() => setDefaultFor(row)}
                    size="sm"
                    variant="ghost"
                  >
                    Set as default
                  </Button>
                ) : null}
                {row.source === "db" ? (
                  <Button
                    aria-label={`Delete ${row.label}`}
                    onClick={() => setDeleting(row)}
                    size="sm"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                ) : null}
              </ItemActions>
            </Item>
          ))}
        </PageRows>
      )}

      <AddProviderDialog
        onClose={() => setAdding(false)}
        onSaved={invalidate}
        open={adding}
      />
      <SetDefaultDialog
        error={setDefault.error}
        onClose={() => setDefaultFor(null)}
        onConfirm={(model) => {
          if (defaultFor) {
            setDefault.mutate({ provider: defaultFor.id, model });
          }
        }}
        pending={setDefault.isPending}
        row={defaultFor}
      />
      <DeleteProviderDialog
        error={remove.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        pending={remove.isPending}
        row={deleting}
      />
    </PageShell>
  );
}

function AddProviderDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const formId = useId();
  const [label, setLabel] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyVariable, setKeyVariable] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [useAsDefault, setUseAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setLabel("");
    setId("");
    setIdEdited(false);
    setBaseUrl("");
    setApiKey("");
    setKeyVariable("");
    setDefaultModel("");
    setUseAsDefault(false);
    setError(null);
    setSaving(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!label.trim() || !id.trim() || !baseUrl.trim() || !defaultModel.trim()) {
      setError("Label, ID, base URL and default model are all required.");
      return;
    }
    if (!apiKey.trim() && !keyVariable.trim()) {
      setError(
        "Give the API key itself, or the environment variable it arrives in.",
      );
      return;
    }
    setSaving(true);
    try {
      await addProvider({
        id: id.trim(),
        label: label.trim(),
        base_url: baseUrl.trim(),
        default_model: defaultModel.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(keyVariable.trim() ? { key_variable: keyVariable.trim() } : {}),
        ...(useAsDefault ? { use_as_default: true } : {}),
      });
      await onSaved();
      reset();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add that provider.",
      );
      setSaving(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>
            An OpenAI-compatible endpoint, stored in this deployment's database.
            Its key is held encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form id={formId} noValidate onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-label`}>Name</FieldLabel>
                <Input
                  id={`${formId}-label`}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    if (!idEdited) setId(suggestProviderId(event.target.value));
                  }}
                  placeholder="9Router"
                  value={label}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-id`}>ID</FieldLabel>
                <Input
                  id={`${formId}-id`}
                  onChange={(event) => {
                    setId(event.target.value);
                    setIdEdited(true);
                  }}
                  placeholder="9router"
                  value={id}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-url`}>Base URL</FieldLabel>
                <Input
                  id={`${formId}-url`}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://ninerouter-vzw3.onrender.com/v1"
                  value={baseUrl}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-key`}>API key</FieldLabel>
                <Input
                  autoComplete="off"
                  id={`${formId}-key`}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Stored encrypted; never shown again"
                  type="password"
                  value={apiKey}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-keyvar`}>
                  Key variable (optional, instead of a key)
                </FieldLabel>
                <Input
                  id={`${formId}-keyvar`}
                  onChange={(event) => setKeyVariable(event.target.value)}
                  placeholder="NINEROUTER_API_KEY"
                  value={keyVariable}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-model`}>
                  Default model
                </FieldLabel>
                <Input
                  id={`${formId}-model`}
                  onChange={(event) => setDefaultModel(event.target.value)}
                  placeholder="auto"
                  value={defaultModel}
                />
              </Field>
              <Field>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={useAsDefault}
                    onCheckedChange={(checked) =>
                      setUseAsDefault(checked === true)
                    }
                  />
                  Use as the deployment default
                </label>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
            </FieldGroup>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={saving} form={formId} type="submit">
            {saving ? "Adding…" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetDefaultDialog({
  row,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  row: ProviderRow | null;
  error: Error | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (model: string | undefined) => void;
}) {
  const formId = useId();
  const [model, setModel] = useState<string | null>(null);
  const shownModel = model ?? row?.defaultModel ?? "";

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setModel(null);
          onClose();
        }
      }}
      open={row !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set as default</DialogTitle>
          <DialogDescription>
            Every built-in Bot will run on {row?.label} from the next server
            start. The stored default outranks BOT_PROVIDER/BOT_MODEL.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              onConfirm(shownModel.trim() ? shownModel.trim() : undefined);
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-model`}>Model</FieldLabel>
                <Input
                  id={`${formId}-model`}
                  onChange={(event) => setModel(event.target.value)}
                  value={shownModel}
                />
              </Field>
              {error ? <FieldError>{error.message}</FieldError> : null}
            </FieldGroup>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending} form={formId} type="submit">
            {pending ? "Setting…" : "Set as default"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProviderDialog({
  row,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  row: ProviderRow | null;
  error: Error | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={row !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {row?.label}?</DialogTitle>
          <DialogDescription>
            The provider row is removed from the database.
            {row?.isDefault
              ? " It is the current default, so the default clears too and selection falls back to the environment."
              : ""}{" "}
            This applies from the next server start.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogBody>
            <FieldError>{error.message}</FieldError>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending} onClick={onConfirm} variant="destructive">
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
