import { useCallback, useEffect, useRef, useState } from "react";
import { savePage, type Page } from "./api";

/**
 * Autosave for one page draft, following OpenDots' shape: an 800 ms debounce after the last
 * edit, the revision the draft was written against sent with every save, and a conflict as a
 * STATE rather than an error — on a 409 the draft is kept, the person is told, and nothing is
 * retried or overwritten until they choose to load the latest version.
 */

export type PageDraft = {
  title: string;
  content: string;
  editorState: Record<string, unknown> | null;
  parentId: string | null;
};

export type AutosaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export function usePageAutosave(page: Page) {
  const [draft, setDraftState] = useState<PageDraft>({
    title: page.title,
    content: page.content,
    editorState: page.editorState,
    parentId: page.parentId,
  });
  const [status, setStatus] = useState<AutosaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(page.revision);
  const draftRef = useRef(draft);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  // A different page (navigation) starts a fresh draft; a newer revision of the SAME page
  // arriving from a poll does not clobber an in-progress draft — that is what the conflict
  // state is for.
  const pageIdRef = useRef(page.id);
  useEffect(() => {
    if (pageIdRef.current !== page.id) {
      pageIdRef.current = page.id;
      revisionRef.current = page.revision;
      const fresh = {
        title: page.title,
        content: page.content,
        editorState: page.editorState,
        parentId: page.parentId,
      };
      draftRef.current = fresh;
      setDraftState(fresh);
      setStatus("saved");
      setError(null);
    }
  }, [page]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (savingRef.current) return false;
    if (draftRef.current.title === page.title && draftRef.current.content === page.content && status === "saved") {
      return true;
    }
    savingRef.current = true;
    setStatus("saving");
    try {
      const outcome = await savePage(page.spaceId, page.id, {
        ...draftRef.current,
        expectedRevision: revisionRef.current,
      });
      if (outcome.ok) {
        revisionRef.current = outcome.page.revision;
        setStatus("saved");
        setError(null);
        return true;
      }
      if (outcome.conflict) {
        setStatus("conflict");
        setError(
          "This page changed elsewhere. Your draft is safe — copy it before loading the latest version.",
        );
        return false;
      }
      setStatus("error");
      setError(outcome.error);
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [page.id, page.spaceId, page.title, page.content, status]);

  const setDraft = useCallback(
    (next: Partial<PageDraft>) => {
      const merged = { ...draftRef.current, ...next };
      draftRef.current = merged;
      setDraftState(merged);
      setStatus((current) => (current === "conflict" ? current : "dirty"));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush();
      }, 800);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { draft, setDraft, status, error, flush };
}
