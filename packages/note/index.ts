import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel,
} from 'hydrooj';

export const TYPE_NOTE: 108 = 108;
export interface NoteDoc {
    docType: 108;
    docId: ObjectId;
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    nReply: number;
    views: number;
    reply: any[];
    react: Record<string, number>;
}
declare module 'hydrooj' {
    interface Model {
        note: typeof NoteModel;
    }
    interface DocType {
        [TYPE_NOTE]: NoteDoc;
    }
}

export class NoteModel {
    static async add(
        owner: number, title: string, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<NoteDoc> = {
            content,
            owner,
            title,
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
        };
        const res = await DocumentModel.add(
            'system', payload.content!, payload.owner!, TYPE_NOTE,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }

    static async get(did: ObjectId): Promise<NoteDoc> {
        return await DocumentModel.get('system', TYPE_NOTE, did);
    }

    static edit(did: ObjectId, title: string, content: string): Promise<NoteDoc> {
        const payload = { title, content };
        return DocumentModel.set('system', TYPE_NOTE, did, payload);
    }

    static inc(did: ObjectId, key: NumberKeys<NoteDoc>, value: number): Promise<NoteDoc | null> {
        return DocumentModel.inc('system', TYPE_NOTE, did, key, value);
    }

    static del(did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne('system', TYPE_NOTE, did),
            DocumentModel.deleteMultiStatus('system', TYPE_NOTE, { docId: did }),
        ]) as any;
    }

    static count(query: Filter<NoteDoc>) {
        return DocumentModel.count('system', TYPE_NOTE, query);
    }

    static getMulti(query: Filter<NoteDoc> = {}) {
        return DocumentModel.getMulti('system', TYPE_NOTE, query)
            .sort({ _id: -1 });
    }

    static async addReply(did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            DocumentModel.push('system', TYPE_NOTE, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet('system', TYPE_NOTE, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus('system', TYPE_NOTE, did, uid, { star });
    }

    static getStatus(did: ObjectId, uid: number) {
        return DocumentModel.getStatus('system', TYPE_NOTE, did, uid);
    }

    static setStatus(did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus('system', TYPE_NOTE, did, uid, $set);
    }
}

global.Hydro.model.note = NoteModel;

class NoteHandler extends Handler {
    ddoc?: NoteDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await NoteModel.get(did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}

class NoteUserHandler extends NoteHandler {
    @param('uid', Types.Int)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, uid: number, page = 1) {
        const [ddocs, dpcount] = await paginate(
            NoteModel.getMulti({ owner: uid }),
            page,
            10,
        );
        const udoc = await UserModel.getById(domainId, uid);
        this.response.template = 'note_main.html';
        this.response.body = {
            ddocs,
            dpcount,
            udoc,
            page,
        };
    }
}

class NoteDetailHandler extends NoteHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await NoteModel.getStatus(did, this.user._id)
            : null;
        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);
        if (!dsdoc?.view) {
            await Promise.all([
                NoteModel.inc(did, 'views', 1),
                NoteModel.setStatus(did, this.user._id, { view: true }),
            ]);
        }
        this.response.template = 'note_detail.html';
        this.response.body = {
            ddoc: this.ddoc, dsdoc, udoc,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await NoteModel.setStar(did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await NoteModel.setStar(did, this.user._id, false);
        this.back({ star: false });
    }
}

class NoteEditHandler extends NoteHandler {
    async get() {
        this.response.template = 'note_edit.html';
        this.response.body = { ddoc: this.ddoc };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_note', 3600, 60);
        const did = await NoteModel.add(this.user._id, title, content, this.request.ip);
        this.response.body = { did };
        this.response.redirect = this.url('note_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            NoteModel.edit(did, title, content),
            OplogModel.log(this, 'note.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('note_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            NoteModel.del(did),
            OplogModel.log(this, 'note.delete', this.ddoc),
        ]);
        this.response.redirect = this.url('note_main', { uid: this.ddoc!.owner });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('note_main', '/note/:uid', NoteUserHandler);
    ctx.Route('note_create', '/note/:uid/create', NoteEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('note_detail', '/note/:uid/:did', NoteDetailHandler);
    ctx.Route('note_edit', '/note/:uid/:did/edit', NoteEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.inject('UserDropdown', 'note_main', (h) => ({ icon: 'book', displayName: 'Note', uid: h.user._id.toString() }),
        PRIV.PRIV_USER_PROFILE);
    ctx.i18n.load('zh', {
        "{0}'s note": '{0} 的笔记',
        Note: '笔记',
        note_detail: '笔记详情',
        note_edit: '编辑笔记',
        note_main: '笔记',
    });
    ctx.i18n.load('zh_TW', {
        "{0}'s note": '{0} 的部落格',
        Note: '部落格',
        note_detail: '部落格詳情',
        note_edit: '編輯部落格',
        note_main: '部落格',
    });
    ctx.i18n.load('kr', {
        "{0}'s note": '{0}의 블로그',
        Note: '블로그',
        note_main: '블로그',
        note_detail: '블로그 상세',
        note_edit: '블로그 수정',
    });
    ctx.i18n.load('en', {
        note_main: 'Note',
        note_detail: 'Note Detail',
        note_edit: 'Edit Note',
    });
}
