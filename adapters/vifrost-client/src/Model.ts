import { applyModelAttributes } from './relationAttributes.js'
import { client, getRegistry, getUnloadedRelationAccess } from './config.js'
import { guardUnloadedRelations } from './RelationGuard.js'
import { QueryBuilder } from './QueryBuilder.js'
import { toModelCollection } from './ModelCollection.js'
import { buildQueryString, createQueryState } from './queryString.js'
import type { ModelCollection } from './ModelCollection.js'
import type { ModelConstructor, ModelId, PrimaryKey } from './types.js'

const NO_INCLUDES: string[] = []

const persistedInstances = new WeakSet<object>()

/**
 * Base class generated `@vifrost/codegen` subclasses extend.
 *
 * @remarks
 * Every constructor argument is copied directly onto the instance, so a
 * generated subclass can declare its columns as typed fields
 * (`declare name: string`) and get correct property access without any
 * getter/setter boilerplate.
 */
export class Model {
  static resource = ''
  static primaryKey: PrimaryKey = 'id'
  /** Joins the values of a composite primary key in URLs and {@link Registry} keys. */
  static keySeparator = ','
  /**
   * Permissive default for hand-written subclasses that don't set this — no
   * enforcement unless opted into. `@vifrost/codegen`-generated classes
   * always set this precisely from the schema.
   */
  static maxLimit: number | null = null;
  /**
   * Names of the relation-loader methods this class declares (e.g.
   * `["category", "comments"]`) — `@vifrost/codegen`-generated classes always
   * set this precisely; hand-written subclasses default to `[]` (no
   * enforcement) unless they opt in. See {@link Model.instantiate}.
   */
  static relations: string[] = [];

  [attributeName: string]: unknown

  constructor(attributes: Record<string, unknown> = {}) {
    applyModelAttributes(this, attributes, (this.constructor as ModelConstructor).relations)
  }

  private primaryKeyValue(): string | number {
    const modelConstructor = this.constructor as ModelConstructor
    const value = modelConstructor.keyOf(this)
    if (value === null) {
      const columns = ([] as string[]).concat(modelConstructor.primaryKey)
      throw new Error(`${modelConstructor.name} instance has no "${columns.join('", "')}" set.`)
    }
    return value
  }

  /**
   * Returns the id of a record as it appears in URLs and {@link Registry} keys.
   *
   * @param {Record<string, unknown>} attributes the record's attributes
   * @returns {string | number | null} the key value; for a composite key, its URI-encoded values joined
   *   by `keySeparator`; `null` if any key column is unset
   */
  static keyOf(this: ModelConstructor, attributes: Record<string, unknown>): string | number | null {
    const primaryKey = this.primaryKey
    if (typeof primaryKey === 'string') {
      const value = attributes[primaryKey]
      return value === undefined || value === null ? null : (value as string | number)
    }
    const values = primaryKey.map((column) => attributes[column])
    if (values.some((value) => value === undefined || value === null)) {
      return null
    }
    return this.encodeId(values as Array<string | number>)
  }

  /**
   * Turns an id given to `find()` or `whereId()` into its URL segment.
   *
   * @param {ModelId} id a single key value, or the values of a composite key in the order of its columns
   * @returns {string | number} the id as it appears in URLs
   */
  static encodeId(this: ModelConstructor, id: ModelId): string | number {
    if (typeof id === 'string' || typeof id === 'number') {
      return id
    }
    return id.map((value) => encodeURIComponent(String(value))).join(this.keySeparator)
  }

  /**
   * Whether a record with a composite key came from the server, since its key columns are already set
   * before it is created.
   *
   * @returns {boolean}
   */
  private isPersisted(): boolean {
    const modelConstructor = this.constructor as ModelConstructor
    if (typeof modelConstructor.primaryKey === 'string') {
      return modelConstructor.keyOf(this) !== null
    }
    return persistedInstances.has(this)
  }

  /**
   * Reads `X-Total-Count` off a collection response's headers — how many rows
   * match the request in total, independent of how many this page returned.
   * Falls back to the page size itself if the header is missing (an older
   * backend, or a response mocked without it in a test), so `.total` is
   * always a valid number rather than `NaN`.
   */
  private static readTotalCount(headers: Headers, pageSize: number): number {
    return Number(headers.get('X-Total-Count') ?? pageSize)
  }

  /**
   * Wraps raw JSON in a Model instance and, if a {@link Registry} was passed
   * to {@link configure}, registers it so a future "this record changed"
   * event can find and refresh it. Every fetch path (find/all/query/
   * relations) goes through this, so tracking is automatic whenever the
   * registry is in use, and entirely skipped otherwise.
   *
   * @param includes the `.with(...)` relations this row was originally
   *   fetched with, if any — threaded through so the registered resync
   *   function re-requests the same relations later, via the same
   *   `query().with(...).whereId(id).first()` chain a caller would use
   *   directly. Without this, a `Registry.resync()` triggered by a
   *   real-time event would silently drop any eager-loaded relation.
   */
  static instantiate<T extends Model>(
    this: ModelConstructor<T>,
    attributes: Record<string, unknown>,
    includes: string[] = NO_INCLUDES
  ): T {
    const instance = new this(attributes)
    persistedInstances.add(instance)
    const registry = getRegistry()
    const primaryKeyValue = this.keyOf(attributes)
    if (registry && primaryKeyValue !== null) {
      registry.track(this.resource, primaryKeyValue, instance, () =>
        this.query()
          .with(...includes)
          .whereId(primaryKeyValue)
          .first() as Promise<T>
      )
    }

    const mode = getUnloadedRelationAccess()
    if (mode === 'off' || this.relations.length === 0) {
      return instance
    }
    const unloadedRelationNames = this.relations.filter((name) => !Object.prototype.hasOwnProperty.call(instance, name))
    const guarded = guardUnloadedRelations(instance, unloadedRelationNames, mode)
    persistedInstances.add(guarded)
    return guarded
  }

  /** Shorthand for `query().get()` — goes through the same `maxLimit` guard as any other collection fetch. */
  static async all<T extends Model>(this: ModelConstructor<T>): Promise<ModelCollection<T>> {
    return this.query().get()
  }

  static async find<T extends Model>(this: ModelConstructor<T>, id: ModelId): Promise<T> {
    const { body: row } = await client().get<Record<string, unknown>>(`${this.resource}/${this.encodeId(id)}`)
    return this.instantiate(row)
  }

  static query<T extends Model>(this: ModelConstructor<T>): QueryBuilder<T> {
    return new QueryBuilder<T>(
      this.resource,
      async (path, includes) => {
        const { body: rows, headers } = await client().get<Record<string, unknown>[]>(path)
        return toModelCollection(
          rows.map((row) => this.instantiate(row, includes)),
          Model.readTotalCount(headers, rows.length)
        )
      },
      async (id, includes) => {
        const state = createQueryState()
        state.includes = includes
        const { body: row } = await client().get<Record<string, unknown>>(
          `${this.resource}/${this.encodeId(id)}${buildQueryString(state)}`
        )
        return this.instantiate(row, includes)
      },
      this.maxLimit,
      this
    )
  }

  /**
   * Creates (no primary key set) or updates (primary key set) this record.
   *
   * @remarks
   * Registers the saved value with the {@link Registry}, if one is
   * configured, the same way `find`/`all`/`query` do — so a create is
   * discoverable by a later `subscribe`, and an update notifies whoever
   * already subscribed to this record from an earlier fetch. It also tells
   * the Registry's resource listeners (such as the lists of `QueryCache`),
   * since a created or updated record can enter or leave them.
   */
  async save(): Promise<this> {
    const modelConstructor = this.constructor as ModelConstructor
    const attributes: Record<string, unknown> = { ...this }
    const isUpdate = this.isPersisted()

    const { body: updatedRow } = isUpdate
      ? await client().put<Record<string, unknown>>(`${modelConstructor.resource}/${this.primaryKeyValue()}`, attributes)
      : await client().post<Record<string, unknown>>(modelConstructor.resource, attributes)

    applyModelAttributes(this, updatedRow, modelConstructor.relations)
    persistedInstances.add(this)

    const registry = getRegistry()
    const savedId = modelConstructor.keyOf(this)
    if (registry && savedId !== null) {
      registry.track(modelConstructor.resource, savedId, this, () => modelConstructor.find(savedId))
      registry.publish(modelConstructor.resource, { type: isUpdate ? 'updated' : 'created', id: savedId })
    }

    return this
  }

  /**
   * Deletes this record, notifying the {@link Registry} (if one is
   * configured) that it's gone.
   */
  async delete(): Promise<void> {
    const modelConstructor = this.constructor as ModelConstructor
    const primaryKeyValue = this.primaryKeyValue()
    await client().delete(`${modelConstructor.resource}/${primaryKeyValue}`)
    persistedInstances.delete(this)
    getRegistry()?.remove(modelConstructor.resource, primaryKeyValue)
  }

  /**
   * Loads one or more of this model's declared relations on an
   * already-instantiated record — for filling in what a fetch didn't
   * eager-load via `.with(...)`, without re-fetching the whole row.
   *
   * @remarks
   * Validates every name against `static relations` (see
   * `@vifrost/codegen`'s generated `relations` array) *before* fetching
   * anything — a typo or an unsupported relation (MorphTo, one outside the
   * generation batch) throws immediately
   *
   * @throws if any name isn't in `static relations`
   */
  async load(relationNames: string[]): Promise<this> {
    const modelConstructor = this.constructor as ModelConstructor
    const invalidNames = relationNames.filter((name) => !modelConstructor.relations.includes(name))
    if (invalidNames.length > 0) {
      throw new Error(
        `${modelConstructor.name} has no relation(s) named: ${invalidNames.join(', ')}. ` +
          `Available: ${modelConstructor.relations.join(', ') || '(none)'}.`
      )
    }

    const values = await Promise.all(relationNames.map((name) => (this[name] as () => Promise<unknown>)()))

    relationNames.forEach((name, index) => {
      this[name] = values[index]
    })

    return this
  }

  /**
   * One-hop collection relation: `GET {resource}/{id}/{relationName}` — the
   * same generated `index()` action as a flat collection fetch (see
   * `MakeAPICommand::buildNestedRoutes()` on the Laravel side), so it carries
   * the same `X-Total-Count` header.
   */
  protected async toMany<R extends Model>(
    relationName: string,
    related: ModelConstructor<R>
  ): Promise<ModelCollection<R>> {
    const modelConstructor = this.constructor as ModelConstructor
    const { body: rows, headers } = await client().get<Record<string, unknown>[]>(
      `${modelConstructor.resource}/${this.primaryKeyValue()}/${relationName}`
    )
    return toModelCollection(
      rows.map((row) => related.instantiate(row)),
      Model.readTotalCount(headers, rows.length)
    )
  }

  /**
   * A to-one relation (BelongsTo/HasOne/MorphOne).
   */
  protected async toOne<R extends Model>(relationName: string, related: ModelConstructor<R>): Promise<R | null> {
    const relatedRows = await this.toMany(relationName, related)
    return relatedRows[0] ?? null
  }

  /**
   * One record within a collection relation, scoped by its own id:
   * `GET {resource}/{id}/{relationName}/{childId}`.
   */
  protected async toManyChild<R extends Model>(
    relationName: string,
    related: ModelConstructor<R>,
    childId: string | number
  ): Promise<R> {
    const modelConstructor = this.constructor as ModelConstructor
    const { body: row } = await client().get<Record<string, unknown>>(
      `${modelConstructor.resource}/${this.primaryKeyValue()}/${relationName}/${childId}`
    )
    return related.instantiate(row)
  }
}
