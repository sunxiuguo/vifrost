import { afterEach, describe, expect, it, vi } from 'vitest'
import { Model } from '../src/Model.js'
import { configure, resetClient } from '../src/config.js'
import { Registry } from '../src/Registry.js'
class Staff extends Model { static resource = 'staff' }
class Appointment extends Model {
  static resource = 'appointment'
  static relations = ['staffMember', 'staffMembers', 'APIKey']
  staffMember() { return this.toOne('staffMember', Staff) }
  staffMembers() { return this.toMany('staffMembers', Staff) }
  APIKey() { return this.toOne('APIKey', Staff) }
}
const response = (row: unknown) => new Response(JSON.stringify([row]), { headers: { 'content-type': 'application/json' } })
afterEach(resetClient)
describe('declared relation serialization aliases', () => {
  it.each(['error', 'off'] as const)('hydrates snake case through query in %s guard mode', async mode => {
    const fetch = vi.fn(async (..._args: any[]) => response({ id: 1, staff_member: { name: 'Synthetic' } }))
    configure({ baseUrl: 'https://synthetic.invalid', fetch, unloadedRelationAccess: mode })
    const [row] = await Appointment.query().with('staffMember').limit(1).get()
    expect((row.staffMember as any).name).toBe('Synthetic')
    expect(row.staff_member).toBe(row.staffMember)
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get('include')).toBe('staffMember')
  })
  it.each([null, [], [{ id: 2 }]])('retains loaded values %j', value => {
    configure({ baseUrl: 'https://synthetic.invalid', unloadedRelationAccess: 'error' })
    const row = Appointment.instantiate({ id: 1, staff_members: value })
    expect(row.staffMembers).toBe(value)
    expect(row.staff_members).toBe(value)
  })
  it.each([null, undefined, { id: 3 }])('prefers own camelCase key even when %j', value => {
    const row = Appointment.instantiate({ id: 1, staffMember: value, staff_member: { id: 2 } })
    expect(row.staffMember).toBe(value)
    expect(row.staff_member).toBe(value) // canonical wins both synchronized views
  })
  it('does not mutate input or camelize ordinary columns and matches Laravel acronym splitting', () => {
    const attrs = Object.freeze({ id: 1, a_p_i_key: { id: 9 }, ordinary_column: 'untouched' })
    const row = Appointment.instantiate(attrs)
    expect(row.APIKey).toBe(attrs.a_p_i_key)
    expect(row.ordinary_column).toBe('untouched')
    expect(Object.hasOwn(row, 'ordinaryColumn')).toBe(false)
    expect(Object.hasOwn(attrs, 'APIKey')).toBe(false)
  })
  it('preserves camel-only responses and already snake-case declared names', () => {
    class AlreadySnake extends Model { static relations = ['staff_member', 'owner'] }
    const staff = { id: 2 }
    expect(Appointment.instantiate({ id: 1, staffMember: staff }).staffMember).toBe(staff)
    const row = AlreadySnake.instantiate({ id: 1, staff_member: staff, owner: null })
    expect(row.staff_member).toBe(staff)
    expect(row.owner).toBe(null)
    expect(Object.hasOwn(row, 'staffMember')).toBe(false)
  })
  it('still rejects unloaded relation property access', () => {
    configure({ baseUrl: 'https://synthetic.invalid', unloadedRelationAccess: 'error' })
    expect(() => (Appointment.instantiate({ id: 1 }).staffMember as any).name).toThrow("hasn't been loaded")
  })
  it('normalizes registry resync responses with the original include', async () => {
    const registry = new Registry()
    const fetch = vi.fn().mockResolvedValueOnce(response({ id: 1, staff_member: { id: 2 } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, staff_member: { id: 3 } }), { headers: { 'content-type': 'application/json' } }))
    configure({ baseUrl: 'https://synthetic.invalid', fetch, registry, unloadedRelationAccess: 'error' })
    await Appointment.query().with('staffMember').get()
    const updated = vi.fn(); registry.subscribe('appointment', 1, updated)
    await registry.resync('appointment', 1)
    expect(updated).toHaveBeenCalled()
    expect(updated.mock.calls.at(-1)![0].value.staffMember).toEqual({ id: 3 })
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('include')).toBe('staffMember')
  })
})
