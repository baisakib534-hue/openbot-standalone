import { Extension, type Editor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBlockquote,
  IconBold,
  IconChecklist,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconMinus,
  IconTable,
} from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The page editor: TipTap over markdown, the same engine and extension set OpenDots uses
 * (StarterKit, tables, task lists, the Markdown extension, slash commands). Markdown is what
 * travels — the editor is loaded from it and read back as it — so a page written here is a page
 * any markdown tool can read, and the editor's JSON is only a reopening convenience the server
 * keeps beside it. All colours come from the app's theme tokens, so the editor looks right
 * under every skin the app ships.
 */

type Block = {
  title: string;
  run: (editor: Editor) => void;
};

const BLOCKS: Block[] = [
  { title: "Text", run: (e) => e.chain().focus().setParagraph().run() },
  { title: "Heading 1", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { title: "Heading 2", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { title: "Heading 3", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { title: "Bullet list", run: (e) => e.chain().focus().toggleBulletList().run() },
  { title: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { title: "Checklist", run: (e) => e.chain().focus().toggleTaskList().run() },
  { title: "Quote", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { title: "Code", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { title: "Divider", run: (e) => e.chain().focus().setHorizontalRule().run() },
  {
    title: "Table",
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
];

/** The `/` menu, as a small DOM popup in the suggestion plugin's own shape. */
function slashMenu() {
  let element: HTMLDivElement | null = null;
  let items: Block[] = [];
  let selected = 0;
  let command: ((block: Block) => void) | null = null;

  const render = () => {
    if (!element) return;
    element.replaceChildren();
    items.forEach((block, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = block.title;
      button.className = cn(
        "block w-full px-3 py-1.5 text-left text-sm text-popover-foreground hover:bg-accent",
        index === selected && "bg-accent",
      );
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        command?.(block);
      });
      element?.append(button);
    });
  };

  return {
    onStart(props: SuggestionProps<Block>) {
      items = props.items;
      selected = 0;
      command = (block) => props.command(block);
      element = document.createElement("div");
      element.className =
        "fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md";
      const rect = props.clientRect?.();
      if (rect) {
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.bottom + 4}px`;
      }
      document.body.append(element);
      render();
    },
    onUpdate(props: SuggestionProps<Block>) {
      items = props.items;
      command = (block) => props.command(block);
      const rect = props.clientRect?.();
      if (element && rect) {
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.bottom + 4}px`;
      }
      render();
    },
    onKeyDown(props: { event: KeyboardEvent }) {
      if (props.event.key === "ArrowDown") {
        selected = (selected + 1) % Math.max(items.length, 1);
        render();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selected = (selected - 1 + items.length) % Math.max(items.length, 1);
        render();
        return true;
      }
      if (props.event.key === "Enter") {
        if (items[selected]) command?.(items[selected]);
        return true;
      }
      return false;
    },
    onExit() {
      element?.remove();
      element = null;
    },
  };
}

const SlashCommands = Extension.create({
  name: "slashCommands",
  addProseMirrorPlugins() {
    return [
      Suggestion<Block>({
        editor: this.editor,
        char: "/",
        startOfLine: true,
        items: ({ query }) =>
          BLOCKS.filter((block) =>
            block.title.toLowerCase().includes(query.toLowerCase()),
          ),
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          props.run(editor);
        },
        render: slashMenu,
      }),
    ];
  },
});

export function documentExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: false },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}

export function PageEditor({
  initialMarkdown,
  onChange,
}: {
  initialMarkdown: string;
  onChange: (markdown: string, editorState: Record<string, unknown>) => void;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editor = useEditor({
    extensions: [
      ...documentExtensions(),
      Markdown,
      Placeholder.configure({
        placeholder: "Start writing, or type / for blocks…",
      }),
      SlashCommands,
    ],
    content: initialMarkdown,
    contentType: "markdown",
    onUpdate: ({ editor: current }) => {
      onChangeRef.current(
        current.getMarkdown(),
        current.getJSON() as Record<string, unknown>,
      );
    },
  });

  useEffect(() => () => editor?.destroy(), [editor]);
  if (!editor) return null;

  const toolButton = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    active = false,
    disabled = false,
  ) => (
    <Button
      key={label}
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={action}
    >
      {icon}
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border pb-2">
        {toolButton("Bold", <IconBold size={16} />, () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"))}
        {toolButton("Italic", <IconItalic size={16} />, () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"))}
        {toolButton("Heading 1", <IconH1 size={16} />, () => editor.chain().focus().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
        {toolButton("Heading 2", <IconH2 size={16} />, () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
        {toolButton("Heading 3", <IconH3 size={16} />, () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
        {toolButton("Bullet list", <IconList size={16} />, () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"))}
        {toolButton("Numbered list", <IconListNumbers size={16} />, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"))}
        {toolButton("Checklist", <IconChecklist size={16} />, () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"))}
        {toolButton("Quote", <IconBlockquote size={16} />, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"))}
        {toolButton("Code block", <IconCode size={16} />, () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive("codeBlock"))}
        {toolButton("Table", <IconTable size={16} />, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {toolButton("Divider", <IconMinus size={16} />, () => editor.chain().focus().setHorizontalRule().run())}
        {toolButton(
          "Link",
          <IconLink size={16} />,
          () => {
            const url = window.prompt("Link URL");
            if (url && /^https?:\/\//.test(url)) {
              editor.chain().focus().setLink({ href: url }).run();
            }
          },
          editor.isActive("link"),
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        {toolButton("Undo", <IconArrowBackUp size={16} />, () => editor.chain().focus().undo().run(), false, !editor.can().undo())}
        {toolButton("Redo", <IconArrowForwardUp size={16} />, () => editor.chain().focus().redo().run(), false, !editor.can().redo())}
      </div>
      <EditorContent
        editor={editor}
        className={cn(
          "prose-sm min-h-0 flex-1 overflow-y-auto pt-3",
          "[&_.ProseMirror]:min-h-64 [&_.ProseMirror]:outline-none",
          "[&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-semibold",
          "[&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-semibold",
          "[&_.ProseMirror_h3]:text-lg [&_.ProseMirror_h3]:font-semibold",
          "[&_.ProseMirror_p]:my-2 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6",
          "[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6",
          "[&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:text-muted-foreground",
          "[&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:bg-muted [&_.ProseMirror_pre]:p-3",
          "[&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1",
          "[&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline",
          "[&_.ProseMirror_table]:w-full [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:p-1.5 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:p-1.5 [&_.ProseMirror_th]:text-left",
          "[&_.ProseMirror_ul[data-type=taskList]]:list-none [&_.ProseMirror_ul[data-type=taskList]]:pl-0",
        )}
      />
    </div>
  );
}
