import { afterEach, describe, expect, it, vi } from 'vitest'
import { Model } from '../src/Model.js'
import { configure, resetClient } from '../src/config.js'
class Staff extends Model { static resource = 'staff' }
class Appointment extends Model {
  static resource = 'appointment'
  static relations = ['staffMember']
  staffMember() { return this.toOne('staffMember', Staff) }
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
function transport(body: unknown) {
  const requests: Array<{ url: string; method: string | undefined; body: Record<string, unknown> }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) })
    return json(body)
  })
  configure({ baseUrl: 'https://synthetic.invalid', fetch, unloadedRelationAccess: 'error' })
  return requests
}
afterEach(resetClient)
describe('relation alias write consistency', () => {
  it.each([
    { id: 1, staff_member: { id: 3 } },
    { id: 1, staffMember: { id: 3 } },
    { id: 1, staff_member: { id: 4 }, staffMember: { id: 3 } },
    { id: 1, staffMember: { id: 3 }, staff_member: { id: 4 } },
    { id: 1, staff_member: { id: 4 }, staffMember: null },
  ])('applies PUT response without adding wire keys: %j', async response => {
    const requests = transport(response)
    const row = Appointment.instantiate({ id: 1, staff_member: { id: 2 }, title: 'before' })
    row.title = 'edited'
    await row.save()
    expect(requests[0]).toMatchObject({ method: 'PUT', body: { id: 1, staff_member: { id: 2 }, title: 'edited' } })
    expect(Object.keys(requests[0].body).sort()).toEqual(['id', 'staff_member', 'title'])
    const expected = Object.hasOwn(response, 'staffMember') ? response.staffMember : response.staff_member
    expect(row.staffMember).toEqual(expected)
    expect(row.staff_member).toEqual(expected)
    expect(row.title).toBe('edited')
    expect(Object.keys({ ...row }).sort()).toEqual(['id', 'staff_member', 'title'])
  })
  it('keeps a loaded relation when the normal controller response omits it', async () => {
    const requests = transport({ id: 1, title: 'server normalized' })
    const row = Appointment.instantiate({ id: 1, staff_member: { id: 2 }, title: 'before' })
    row.title = 'edited'; await row.save()
    expect(requests[0].body.title).toBe('edited')
    expect(row.title).toBe('server normalized')
    expect(row.staffMember).toEqual({ id: 2 })
    expect(row.staff_member).toBe(row.staffMember)
  })
  it('supports camel-to-snake responses without adding serialized fields', async () => {
    const requests = transport({ id: 1, staff_member: null })
    const row = Appointment.instantiate({ id: 1, staffMember: { id: 2 } })
    await row.save()
    expect(Object.keys(requests[0].body).sort()).toEqual(['id', 'staffMember'])
    expect(row.staffMember).toBe(null)
    expect(row.staff_member).toBe(null)
    expect(Object.keys({ ...row }).sort()).toEqual(['id', 'staffMember'])
  })
  it('keeps direct assignments synchronized in either direction', async () => {
    const requests = transport({ id: 1 })
    const row = Appointment.instantiate({ id: 1, staff_member: { id: 2 } })
    row.staffMember = { id: 5 } as any
    expect(row.staff_member).toEqual({ id: 5 })
    row.staff_member = null
    expect(row.staffMember).toBe(null)
    await row.save()
    expect(requests[0].body.staff_member).toBe(null)
    expect(Object.hasOwn(requests[0].body, 'staffMember')).toBe(false)
  })
  it('uses the same aliases on POST-created models', async () => {
    const requests = transport({ id: 7, staffMember: { id: 3 }, title: 'saved' })
    const row = new Appointment({ staff_member: { id: 2 }, title: 'draft' })
    await row.save()
    expect(requests[0]).toMatchObject({ method: 'POST', body: { staff_member: { id: 2 }, title: 'draft' } })
    expect(Object.hasOwn(requests[0].body, 'staffMember')).toBe(false)
    expect(row.staffMember).toEqual({ id: 3 })
    expect(row.staff_member).toBe(row.staffMember)
    expect(row.id).toBe(7)
  })
  it('does not invent aliases for separately declared relation names', () => {
    class Ambiguous extends Model { static relations = ['staffMember', 'staff_member'] }
    const camel = { id: 2 }; const snake = { id: 3 }
    const row = Ambiguous.instantiate({ id: 1, staffMember: camel, staff_member: snake })
    expect(row.staffMember).toBe(camel); expect(row.staff_member).toBe(snake)
    const onlySnake = Ambiguous.instantiate({ staff_member: snake })
    expect(Object.hasOwn(onlySnake, 'staffMember')).toBe(false)
  })
  it('does not merge distinct names that serialize to the same alias', () => {
    class Ambiguous extends Model { static relations = ['fooBar', 'FooBar'] }
    const lower = { id: 2 }; const upper = { id: 3 }; const snake = { id: 4 }
    const row = Ambiguous.instantiate({ fooBar: lower, FooBar: upper, foo_bar: snake })
    expect(row.fooBar).toBe(lower); expect(row.FooBar).toBe(upper); expect(row.foo_bar).toBe(snake)
    const onlySnake = Ambiguous.instantiate({ foo_bar: snake })
    expect(Object.hasOwn(onlySnake, 'fooBar')).toBe(false)
    expect(Object.hasOwn(onlySnake, 'FooBar')).toBe(false)
  })
  it('keeps ordinary snake-case columns unrelated to any declared relation', async () => {
    const requests = transport({ id: 1, ordinary_column: 'normalized' })
    const row = Appointment.instantiate({ id: 1, ordinary_column: 'before' })
    row.ordinary_column = 'edited'; await row.save()
    expect(requests[0].body).toEqual({ id: 1, ordinary_column: 'edited' })
    expect(row.ordinary_column).toBe('normalized')
    expect(Object.hasOwn(row, 'ordinaryColumn')).toBe(false)
  })
})
