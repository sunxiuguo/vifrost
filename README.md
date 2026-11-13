# Vifrost

Vifrost generates a REST API — routes, controllers, FormRequests — directly from
your Laravel Eloquent models, and ships a typed frontend ecosystem
(`@vifrost/client`, `@vifrost/codegen`, `@vifrost/vue`) to consume it without
hand-writing HTTP calls.

**This library is NOT stable yet. Use it at your own risk.**

This README is split in three parts:

1. [Backend (Laravel package)](#1-backend-laravel-package)
2. [Models in vanilla JS/TS (`@vifrost/client`)](#2-models-in-vanilla-jsts-vifrostclient), with and without the `Registry`
3. [Vue (`@vifrost/vue`)](#3-vue-vifrostvue)

---

## 1. Backend (Laravel package)

### Requirements

- PHP `^8.3`
- Laravel `^12.0` or `^13.0` (`illuminate/database`, `illuminate/support`, `illuminate/container`, `illuminate/console`)
- [`spatie/laravel-query-builder`](https://spatie.be/docs/laravel-query-builder) `^6.0`

### Installation

```bash
composer require vifrost/laravel
```

The service provider (`Vifrost\Laravel\Providers\VifrostServiceProvider`) is
auto-discovered. Optionally publish the config file to tweak it:

```bash
php artisan vendor:publish --tag=config
```

This publishes `config/vifrost.php`:

```php
return [
    // Columns never exposed in generated FormRequest validation rules. '*.column'
    // matches that column on every table; 'table.column' matches just one table.
    'ignored_columns' => ['*.created_at', '*.updated_at', '*.deleted_at'],

    // URL path segments ignored when resolving a request to a model (compared
    // case-insensitively), e.g. the "api" prefix in /api/product/1.
    'exclude' => ['api'],

    // Where Vifrost::models() looks for Eloquent models, relative to app_path().
    // Scanned live on every call unless `php artisan vifrost:cache` has written a
    // cache file — see "Caching discovered models" below.
    'models_path' => 'Models',

    // Models left out of the schema, codegen, `vifrost:api` (all) and request
    // routing, as FQCNs — e.g. internal models the API should not expose.
    'exclude_models' => [
        // \App\Models\User::class,
    ],

    // Leaves out models that extend Illuminate\Database\Eloquent\Relations\Pivot.
    'exclude_pivots' => true,

    // Joins the values of a composite primary key in URLs — see "Composite primary keys".
    'composite_key_separator' => ',',

    // Where `php artisan vifrost:schema` writes the models/attributes/relations JSON.
    'schema_path' => storage_path('app/vifrost-schema.json'),

    // Off by default: exposes the same JSON at schema_route_path over HTTP, for
    // adapter-generation tooling that needs to read it from a running server
    // instead of from the file the artisan command writes.
    'expose_schema_route' => false,
    'schema_route_path'   => 'api/_schema',
    // Middleware for the schema route, e.g. ['api', 'auth:sanctum'].
    'schema_route_middleware' => [],

    // Off by default: the endpoint @vifrost/client calls to refresh its lists in one
    // request when records change — see "Keeping lists in sync" below.
    'sync_route' => [
        'enabled'     => false,
        'path'        => 'api/_vifrost/sync',
        'middleware'  => ['api'],
        'max_queries' => 20,
    ],

    // Hard ceiling on rows a collection query (index, or a nested relation
    // collection) returns per request, applied even with no ?limit= at all.
    'max_limit' => 100,

    // Per-model overrides, keyed by model FQCN. Set a model's value to null to
    // exempt it from pagination entirely (e.g. a small, rarely-changing lookup table).
    'max_limit_per_model' => [
        // \App\Models\Category::class => null,
    ],

    // Eloquent relation methods Vifrost looks for via reflection when mapping
    // a model's relations (see Mapper.php).
    'relations' => [
        'hasMany', 'hasOne', 'belongsTo', 'belongsToMany',
        'hasOneThrough', 'hasManyThrough',
        'morphOne', 'morphMany', 'morphTo', 'morphToMany', 'morphedByMany',
    ],
];
```

### Usage

Generate a FormRequest, Controller, and routes for one model:

```bash
# Store/UpdateUserRequest + UserController + routes for \App\Models\User
php artisan vifrost:api User
```

Or for every model in `app/Models` (skipping `exclude_models` and, by default, pivots):

```bash
php artisan vifrost:api
```

This appends to `routes/api.php` a flat CRUD group for the model itself...

```php
Route::controller('\App\Http\Controllers\UserController')->group(function () {
    Route::get('user', 'index');
    Route::get('user/{id}', 'show');
    Route::post('user', 'store');
    Route::put('user/{id}', 'update');
    Route::delete('user/{id}', 'destroy');
});
```

...plus one-hop, read-only routes for each of its relations (see [`MakeAPICommand`](src/Commands/MakeAPICommand.php)):

```php
Route::get('user/{id}/posts', [\App\Http\Controllers\PostController::class, 'index']);
Route::get('user/{id}/posts/{childId}', [\App\Http\Controllers\PostController::class, 'show']);
```

Deeper relations (`posts.comments`) aren't routed as their own endpoint — they're
reachable in a single request via Spatie's `?include=posts.comments` on the flat
`index`/`show` route instead, since every generated controller wires
`Spatie\QueryBuilder\QueryBuilder` with `allowedIncludes` for the model's relations.

`vifrost:api` is a one-time kickoff, not something meant to keep `routes/api.php` in
sync forever — the expectation is that you'll hand-edit the generated routes
afterward (adding middleware, auth, dropping a verb, ...), the same way
`vifrost:controller`/`vifrost:request` already refuse to overwrite an existing
Controller/FormRequest unless you pass `--force`. If `routes/api.php` already
references a model's controller, `vifrost:api` asks before appending that model's
route block again, so a later re-run (e.g. generating "all" models after adding one
new one) can't silently reintroduce a route you'd since removed or duplicate ones
you'd since customized. Pass `--force` to skip the prompt (e.g. in CI, or when you
genuinely want a fresh block appended alongside the old one).

Filtering, sorting and includes are opt-in per model, and the generated controller
keeps the first two consolidated in one place — `allowedFilters()`/`allowedIncludes()`
private methods shared by both `index()` and `show()` — so extending them can't
accidentally leave the two endpoints out of sync with each other. `allowedFilters()`
starts empty and `->allowedSorts([...])` ships pre-filled with only
`['id', 'created_at', 'updated_at']`. Edit those methods in
`app/Http/Controllers/{Model}Controller.php` with whichever columns should be
filterable/sortable before relying on `.where()`/`.orderBy()` from the JS client
(part 2) — otherwise Spatie ignores the corresponding query param.

Collection endpoints (`index`, and any nested relation collection) accept
`?limit=` / `?offset=`, resolved in the generated controller's own `index()` method
against the `max_limit` / `max_limit_per_model` config (see
[`Pagination`](src/Pagination.php)) — deliberately not hidden inside `Vifrost::getQuery()`,
so pagination stays visible and editable in the file you actually own. `index()` also
reports how many rows matched (independent of the current page) via an `X-Total-Count`
response header, for building a pager on the client. A model configured as exempt from
pagination (`max_limit_per_model` set to `null`) has no default limit to offset within,
so `?offset=` with no `?limit=` given returns a `422` instead of being silently ignored
— pass an explicit `?limit=` alongside it and it works normally, even for an exempt
model. Single-record endpoints (`show`) never paginate.

You can also generate just one piece:

```bash
php artisan vifrost:request StoreUserRequest User   # FormRequest only
php artisan vifrost:controller User                # Controller only (hidden command, used internally)
```

### Composite primary keys

A model whose table has a composite primary key sets `$primaryKey = null` and
`$incrementing = false`. Vifrost reads the key columns from the table's primary
index and identifies a record by its key values joined with
`composite_key_separator` (`,` by default), in the order of the key columns:

```
GET    /api/staffmemberrole/5,3
PUT    /api/staffmemberrole/5,3
DELETE /api/staffmemberrole/5,3
GET    /api/staffmember/5/roles/5,3
```

`vifrost:api` generates a controller that updates and deletes through a query
scoped by the key, since Eloquent cannot save a model without a single primary
key. Key values must not contain the separator.

### Exporting the schema for the JS/TS tooling

```bash
php artisan vifrost:schema [--path=storage/app/vifrost-schema.json]
```

Writes a JSON map of every model's table, resource name, `maxLimit`, columns
(type, nullability, defaults, foreign keys) and relations — this is what
`@vifrost/codegen` (part 2) reads to generate typed model classes. If
`expose_schema_route` is enabled, the same JSON is served live at
`schema_route_path` (`api/_schema` by default) instead of needing the file.

### Caching discovered models

`Vifrost::models()` (used by every generated controller to resolve `{model}` in a URL,
and by `vifrost:api`/`vifrost:schema` to find "all" models) scans `models_path` and
reflects on every file it finds there, on every call — fine for a handful of models
locally, wasteful on a production request. Nothing is cached by default; opt in with:

```bash
php artisan vifrost:cache   # write bootstrap/cache/vifrost-models.php
php artisan vifrost:clear   # remove it, restoring the live scan
```

This follows the same manually-invalidated convention as `config:cache`/`route:cache`:
once a cache file exists, `models()` reads it instead of scanning — so re-run
`vifrost:cache` after adding, removing, or moving a model, the same way you'd re-run
`config:cache` after editing `.env`. There's no automatic invalidation (a model added
by hand, or by any tool other than vifrost's own generators, wouldn't be visible to
trigger one anyway), so add `vifrost:cache` to your deploy step deliberately if you
use it, rather than relying on it locally.

---

## 2. Models in vanilla JS/TS (`@vifrost/client`)

Framework-agnostic runtime: a `Model` base class, a `QueryBuilder` compatible with
`spatie/laravel-query-builder`'s query params, and an opt-in `Registry` identity map.

### Requirements

- Node 18+ or any modern browser (only depends on native `fetch`)
- TypeScript 5+ recommended

### Installation

```bash
npm install @vifrost/client
npm install --save-dev @vifrost/codegen   # to generate Model classes from your schema
```

### Generating typed model classes

Export the schema from Laravel (part 1), then generate:

```bash
npx vifrost-codegen -i storage/app/vifrost-schema.json -o resources/js/models
```

```
Options:
  -i, --input <pathOrUrl>          schema JSON file path, or the exposed schema route URL
  -o, --output <dir>               directory to write the generated .ts files to
  -t, --type-map <path>            JSON file with { "dbTypeName": "tsType" } overrides
  -c, --client-import <specifier>  import specifier for the runtime client (default: "@vifrost/client")
```

This produces one file per model:

```typescript
// resources/js/models/Product.ts — generated, do not edit by hand
import { Model } from '@vifrost/client'
import { Category } from './Category.js'

export class Product extends Model {
  static resource = 'product'
  static primaryKey = 'id'
  static maxLimit = 100 // null if this model is exempt from pagination

  declare id: number
  declare name: string
  declare price: string
  declare category_id: number

  category(): Promise<Category | null> {
    return this.toOne('category', Category)
  }
}
```

### 2.1 Without a `Registry` (plain query API)

Call `configure()` once, then use each model's static/instance methods directly —
nothing is tracked or cached beyond the lifetime of each call.

```typescript
import { configure } from '@vifrost/client'
import { Category } from './models/Category.js'
import { Product } from './models/Product.js'

configure({ baseUrl: 'https://api.example.com/api' })

// find / all
const product = await Product.find(1)
const allActive = await Product.query().where('status', 'active').limit(10).get()

// Eloquent-like chaining: where / orderBy / with / limit / offset (take/skip aliases)
const products = await Product.query()
  .where('category_id', 3)
  .orderBy('created_at', 'desc')
  .with('category')
  .limit(20)
  .offset(40)
  .get()

// whereId(id).first() — hits the dedicated GET /product/{id} endpoint, not a filtered collection
const one = await Product.query().whereId(1).first()

// relations, from an already-loaded instance
const category = await product.category()          // BelongsTo/HasOne/MorphOne -> Model | null
const relatedProducts = await category.products()   // HasMany/BelongsToMany/etc -> Model[]

// create / update / delete
const created = await new Product({ name: 'New', price: '9.99', category_id: 3 }).save()
created.price = '12.99'
await created.save()          // PUT, since the primary key is now set
await created.delete()
```

Loaded relations declared in `static relations` accept Laravel's snake-case
serialization: for example, `staff_member` can be read as `staffMember`. Only
unambiguous declared relation names are aliased; ordinary column names are not
converted. If a response contains both names, its own canonical key wins for
both views, including an explicit `null` or `undefined`.

The two names share one value, so assignment and later `save()` responses stay
consistent. Added aliases are non-enumerable: they do not add keys to the
serialized payload, and the initially received wire keys remain enumerable.
A save response that omits a loaded relation leaves its value intact. `save()`
still sends the model's enumerable attributes, not a dirty-field patch; this does
not introduce dirty tracking or resolve edits made while a save is in flight.

A model with a composite primary key (see "Composite primary keys" above) declares
its key columns as a list, and takes the key values in that order:

```typescript
class StaffMemberRole extends Model {
  static resource = 'staffmemberrole'
  static primaryKey = ['staff_member_id', 'role_id'] as const
  // static keySeparator = ','  — must match the backend's composite_key_separator
}

const role = await StaffMemberRole.find([5, 3])                // GET /staffmemberrole/5,3
await new StaffMemberRole({ staff_member_id: 5, role_id: 4, level: 1 }).save()  // POST
role.level = 2
await role.save()                                               // PUT /staffmemberrole/5,3
```

Since the key columns are set before a record is created, `save()` sends a PUT
only for records fetched from or already saved to the server.

If a model declares a non-null `static maxLimit` (i.e. the backend requires
pagination for it), `QueryBuilder` fails fast **client-side**, before any network
request:

```typescript
await Product.all()
// throws: "product requires a limit (max 100). Call .limit(n) (n <= 100) before .get()."

await Product.query().limit(1000).get()
// throws: ".limit(1000) exceeds the max allowed for product (100)."
```

This is stricter than the server, which would silently clamp an over-limit
request — the point is to catch it in development instead of silently returning
a truncated page.

### 2.2 With a `Registry` (identity map, kept in sync)

Pass a `Registry` to `configure()` to opt into an identity map: every `find`/`all`/
`query`/relation fetch registers its rows, `save()`/`delete()` publish into the same
map, and anything can `subscribe()` to a specific `resourceType:id` and get notified
in place — no polling, ready to be driven later by a WebSocket/SSE "record changed"
event via `registry.resync(resourceType, id)`.

```typescript
import { configure, Registry } from '@vifrost/client'
import { Product } from './models/Product.js'

const registry = new Registry()
configure({ baseUrl: 'https://api.example.com/api', registry })

const product = await Product.find(1) // now tracked under "product:1"

const unsubscribe = registry.subscribe('product', 1, (event) => {
  if (event.type === 'updated') {
    console.log('fresh value:', event.value)
  } else {
    console.log('record 1 was deleted')
  }
})

// Any later save() on a Product with id 1 — from anywhere in the app — notifies this listener:
product.name = 'Renamed'
await product.save() // -> listener fires with { type: 'updated', value: product }

await product.delete() // -> listener fires with { type: 'deleted' }, then the entry is untracked

unsubscribe()
```

Without a `Registry` configured, `save()`/`delete()` skip this entirely — the
modularity is deliberate: a consumer who only wants the plain query API never pays
for tracking it doesn't use.

### 2.3 Keeping lists in sync

Lists watched through `@vifrost/vue`'s `useQuery` (or `getQueryCache().watch()`)
always share one request per identical query. With a `Registry` configured they also
stay in sync: rows follow the Registry, and the lists of a resource refresh when the
Registry reports one of its records created, updated or deleted, so a new record
enters the lists it belongs to and a changed one moves or leaves. Without a `Registry`,
lists only change when refetched.

Local `save()`/`delete()` report to the Registry on their own. Changes made elsewhere
(another tab, another user) are reported with `events`, typically from a real-time
transport such as Laravel Echo with model broadcasting. Events carry only the record's
id, and `events` encodes it with the model's key the way the Registry tracks it
(`registry.created()`, `registry.updated()` and `registry.remove()` take the encoded id
directly). An update re-fetches the record once if it is tracked, which also refreshes
every list showing it:

```typescript
import { events } from '@vifrost/client'

echo.private(`clinic.${clinicId}.patients`)
  .listen('.PatientCreated', (event) => events.created(Patient, event.id))
  .listen('.PatientUpdated', (event) => events.updated(Patient, event.id))
  .listen('.PatientDeleted', (event) => events.deleted(Patient, event.id))
```

Events that arrive close together (`debounceMs`, 50 by default) are handled at once.
By default each affected list is refetched. To refresh them all in a single request,
enable `sync_route` on the Laravel side and point the client at it:

```typescript
configure({
  baseUrl: 'https://api.example.com/api',
  registry,
  sync: { path: '_vifrost/sync', debounceMs: 50, maxQueries: 20 },
})
```

The endpoint runs each list through the `query()` method of its generated controller,
with filters, sorts, includes and pagination taken from the list's query string, and
returns the page's ids, the total and only the rows the client does not have yet.
Because it does not dispatch a request per list, **the route middleware of each list
does not run**: `sync_route.middleware` guards them all (add your auth middleware
there), and any customization of a list (e.g. scoping it to the current tenant) must
live in the controller's `query()`, which `index()` and `show()` also use, rather than
in `index()`. Controllers generated before `query()` existed, or an endpoint that is
disabled, make the client fall back to refetching. To register the endpoint inside a
route group of your own, leave `enabled` false and call `Vifrost::syncRoute()` there.

---

## 3. Vue (`@vifrost/vue`)

`useModel`/`useQuery` composables wrapping `@vifrost/client`, reactive to both
their inputs (a ref/getter id or query) and — when a `Registry` is configured — to
`Registry` events for the rows they're currently holding.

### Requirements

- Vue `^3.3.0`
- `@vifrost/client` configured somewhere in your app bootstrap (as in part 2)

### Installation

```bash
npm install @vifrost/vue
```

### 3.1 Without a `Registry`

`useQuery`/`useModel` work the same whether or not a `Registry` is configured — the
difference is only whether results stay in sync after the initial fetch (3.2).

```vue
<script setup lang="ts">
import { useModel, useQuery } from '@vifrost/vue'
import { Category } from './models/Category.js'
import { Product } from './models/Product.js'
import { ref } from 'vue'

const productId = ref(1)

// useModel(ModelClass, id) — id can be a plain value, a ref, or a getter
const { data: product, error, isLoading, refetch } = useModel(Product, productId)

// useQuery(builder) — pass a GETTER (not a resolved builder) whenever the query
// depends on something reactive, so it re-runs when that dependency changes
const { data: activeInCategory } = useQuery(() =>
  Product.query().where('category_id', productId.value).where('status', 'active').orderBy('name')
)

// A plain builder is fine too when the query never changes
const { data: categories } = useQuery(Category.query().limit(50))
</script>

<template>
  <p v-if="isLoading">Loading…</p>
  <p v-else-if="error">{{ error }}</p>
  <p v-else>{{ product?.name }}</p>
</template>
```

Both composables return `{ data, error, isLoading, refetch }` — `data` is `null`
(for `useModel`) or `[]` (for `useQuery`) until the first response resolves, and
`refetch()` re-runs the same query on demand.

### 3.2 With a `Registry`

Configure a `Registry` once during app bootstrap (part 2.2) — from a component's
point of view nothing else changes. `useQuery`/`useModel` subscribe to every row
they're currently displaying and patch it in place on an `updated`/`deleted` event,
without an extra network round-trip:

```typescript
// main.ts
import { configure, Registry } from '@vifrost/client'

configure({ baseUrl: 'https://api.example.com/api', registry: new Registry() })
```

```vue
<script setup lang="ts">
import { useModel } from '@vifrost/vue'
import { Product } from './models/Product.js'

const { data: product } = useModel(Product, 1)

async function rename() {
  product.value!.name = 'Renamed'
  await product.value!.save() // any other component's useModel(Product, 1) updates too
}
</script>
```

Because `useModel(Product, 1)` is built on `useQuery` (it resolves through
`Product.query().whereId(1)`, the same endpoint `find()` uses), any two components
that fetched product `1` independently share the same `Registry` entry — a `save()`
in one updates the other's `data` reactively, with no manual event wiring.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss
what you would like to change.

## License

[MIT](https://choosealicense.com/licenses/mit/)
