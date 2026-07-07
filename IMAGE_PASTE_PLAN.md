# Plan: Paste images into the CMS agent panel

## Summary
Let users paste images (e.g. a screenshot/mockup) into the agent composer. The
image is attached to the user message as a base64 data URL, sent to the server,
and forwarded to **vision-capable native models** (Anthropic / OpenAI /
OpenRouter / Ollama — all already map image blocks to native multimodal
content). The image is persisted, replayed on every turn, and rendered as a
thumbnail in the thread.

**Reframe (this branch):** the model already *sees* images today via the
**render_snapshot tool funnel** — `site_render_snapshot` and the render tools
capture a canvas screenshot and push it as an `AiToolOutput.images` entry, which
the drivers turn into native multimodal content. Pasting an image is a *second,
parallel funnel*: it puts the image into the **user message** content block
instead of a tool result. The downstream path (persist → replay → driver
mapping) is identical and already proven. So the work is almost entirely
**ingest + UI + one small server append change** — no driver/provider work.

## Existing image machinery (why this is low-risk)
- `src/admin/pages/site/agent/renderSnapshotTool.ts` pushes
  `{ mimeType, data }` screenshots into `aiToolOk(..., images)`.
- `server/ai/mcp/server.ts` forwards `output.images` as MCP `image` blocks.
- `server/ai/drivers/{chatCompletions,anthropic,responses-shared}.ts` each
  implement `userContent()` mapping a `{kind:'image'}` block to native image
  content (OpenAI `image_url`, Anthropic `image` base64, Responses
  `input_image`). A user-message `{kind:'image'}` block therefore already
  reaches every native provider's vision path with **zero driver changes**.
- `server/ai/conversations/store.ts` persists `AiContentBlock[]` (image kind is
  in `AiContentBlockSchema`); `history.ts` replays them verbatim.

=> Adding a pasted image as a user-message image block reuses an end-to-end
   path that is already exercised by the snapshot tool.

## Data flow (native path only — this branch)
1. Browser: paste event → read image `File` → base64 data URL → local
   `pendingImages` state → thumbnail tray above the textarea.
2. On send: `sendAgentMessage(content, images)` builds user-message blocks (a
   text block if any + one image block per attachment) and POSTs
   `{ conversationId, prompt, snapshot, images }` to `/admin/api/ai/chat/:scope`.
3. Server (`chat.ts`) validates `images`, appends the user message with text +
   image blocks; the driver maps them to native multimodal; persisted and
   replayed on follow-ups.
4. Reload rehydrates the conversation and renders the image blocks as
   thumbnails in the thread.

(No cascade / relay step — see Out of scope. This branch is cut from `main`,
which uses the native `/admin/api/ai/chat/:scope` path only.)

## Files to change

### Browser / types
- **src/admin/pages/site/agent/types.ts**
  - Add `AgentImageAttachment = { mimeType: string; data: string }` (base64, no
    `data:` prefix).
  - Add `| { kind: 'image'; mimeType: string; data: string }` to
    `AgentMessageBlock`.
  - Add `images?: AgentImageAttachment[]` to `AgentRequestBody`.

- **src/admin/pages/site/agent/agentSliceTypes.ts**
  - Change `sendAgentMessage(content: string, images?: AgentImageAttachment[]): Promise<void>`.

- **src/admin/pages/site/agent/agentSlice.ts** (`sendAgentMessage`)
  - Build user-message blocks: a text block (if any) + one image block per
    attachment.
  - Native path: include `images` in the `AgentRequestBody` POST body (replace
    the current `{ conversationId, prompt, snapshot }`).

- **src/admin/pages/site/agent/agentApi.ts** (`rehydrateMessages`)
  - Handle image blocks (currently skipped with a "v1" comment at
    `agentApi.ts:138`) so reloaded conversations show pasted images as
    thumbnails.

### UI
- **src/admin/pages/site/panels/AgentPanel/AgentPanel.tsx**
  - `onPaste` on the textarea capturing `clipboardData.items`/`files` of
    `type.startsWith('image/')`; convert to a data URL; cap size (~10MB) +
    allowed MIME (png/jpeg/webp/gif) → reject with `pushToast` otherwise.
  - Local `pendingImages` state + a thumbnail tray (with remove buttons)
    rendered above the textarea.
  - Pass `pendingImages` to `sendAgentMessage`, then clear.
  - Soft warning when `activeModel.visionInput === false` and images are
    attached (model can't see them).
  - `groupRenderItems` + `MessageBubble`: add an image render item +
    `UserImageBubble` so user-pasted images render as thumbnails in the thread.

- **src/admin/pages/site/panels/AgentPanel/AgentPanel.module.css**
  - Styles for the attachment tray + thumbnail (reuse the existing
    `.toolCallScreenshot` aesthetic).

### Server
- **server/ai/handlers/chat.ts**
  - Add `images` to `ChatRequestBodySchema` (array of
    `{ mimeType: string; data: string }`, validated + length-capped).
  - Make `prompt` optional; require ≥1 of text/image.
  - In the `appendMessage(...)` call, build `content` from text + image blocks
    (currently hard-coded to `[{ kind: 'text', text: prompt }]`).

## Validation & limits
- Allowed MIME: `image/png | image/jpeg | image/webp | image/gif`.
- Per-image cap ~10MB (base64); reject with toast.
- Vision warning when the selected model lacks `visionInput`.

## Tests / verification
- `bun run test` (existing `agentSlice.test.ts` keeps working — `images?` is
  optional; `aiAssistant.ts` spotlight call unaffected).
- Add a chat-handler test asserting an image block is persisted on the user
  message.
- Manual: `bun run dev`, open the agent panel, paste a screenshot, send with a
  vision model (e.g. Claude), confirm the model references the image; reload
  the conversation and confirm the thumbnail reappears.

## Out of scope
- Drag-and-drop file upload (paste only, per request).
- Client-side image downscaling/compression (can add later if size is an issue).
- Cascade / Windsurf relay image forwarding — that lives on the `nodes-mcp`
  branch (`scripts/mcp/relay-daemon.ts` does not exist on `main` and
  `agentSlice.sendAgentMessage` has no cascade branch here). This branch uses
  the native `/admin/api/ai/chat/:scope` path only.
