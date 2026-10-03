export type Block = { id: string; type: string; text: string; revision: string; plain: boolean; topLevelId?: string }
export type Proposal = {
  id: string; type: 'replace' | 'insert' | 'comment' | 'move' | 'replace_text'; jobId: string; text?: string; blockIds?: string[]; preview?: string[]; anchorText?: string;
  find?: string; replace?: string; count?: number; edits?: { blockId: string; blockRevision: string; before: string; after: string; count: number }[]; sessionId: string; explanation: string
  status: string; stale: boolean; createdAt: number
  blockId?: string; blockType?: string; blockLanguage?: string | null; blockRevision?: string; before?: string; after?: string
  anchorBlockId?: string; placement?: 'before' | 'after'; markdown?: string
  insertedIds?: string[]; feedback?: string
}
export type Job = { id: string; instruction: string; status: string; message?: string; kind: string; sessionId: string; sessionName?: string; blockIds: string[]; createdAt: number; finishedAt?: number; directive?: string }
export type Activity = { jobId: string; sessionId: string; blockIds: string[]; state: 'reading' | 'thinking' | 'writing' | 'waiting' | 'done'; progress: number | null; message: string; updatedAt: number }
export type Session = { id: string; name: string; repo: string; connected: boolean; streaming: boolean; connectedAt: number }
export type DocumentState = { id: string; revision: number; json: any; title: string; markdown: string }
export type State = { document: DocumentState; jobs: Job[]; proposals: Proposal[]; activity: Activity[]; sessions: Session[] }

// Library
export type DocumentSummary = { id: string; title: string; folder: string; slug: string; tags: string[]; wordCount: number; updatedAt: string; updatedBy?: string | null }
export type Library = { folders: string[]; documents: DocumentSummary[] }
export type RelatedDoc = { id: string; title: string; folder: string; sharedTags: string[] }
export type LinkedDoc = { id: string; title: string; folder?: string }
export type DocumentMeta = DocumentSummary & { frontmatter: Record<string, unknown>; revision: number; owner?: string | null; related: RelatedDoc[]; links: { out: LinkedDoc[]; in: LinkedDoc[] } }
export type SearchResult = { id: string; title: string; folder: string; tags: string[]; snippet: string; rank: number; updatedAt: string }
export type TagCount = { tag: string; count: number }
export type AccessToken = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt?: string | null }
