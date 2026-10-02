export type Block = { id: string; type: string; text: string; revision: string; plain: boolean; topLevelId?: string }
export type Proposal = {
  id: string; type: 'replace' | 'insert' | 'comment' | 'move'; jobId: string; text?: string; blockIds?: string[]; preview?: string[]; anchorText?: string; sessionId: string; explanation: string
  status: string; stale: boolean; createdAt: number
  blockId?: string; blockType?: string; blockRevision?: string; before?: string; after?: string
  anchorBlockId?: string; placement?: 'before' | 'after'; markdown?: string
  insertedIds?: string[]; feedback?: string
}
export type Job = { id: string; instruction: string; status: string; message?: string; kind: string; sessionId: string; sessionName?: string; blockIds: string[]; createdAt: number; finishedAt?: number; directive?: string }
export type Activity = { jobId: string; sessionId: string; blockIds: string[]; state: 'reading' | 'thinking' | 'writing' | 'waiting' | 'done'; progress: number | null; message: string; updatedAt: number }
export type Session = { id: string; name: string; repo: string; connected: boolean; streaming: boolean; connectedAt: number }
export type DocumentState = { id: string; revision: number; json: any; title: string; markdown: string }
export type State = { document: DocumentState; jobs: Job[]; proposals: Proposal[]; activity: Activity[]; sessions: Session[] }
