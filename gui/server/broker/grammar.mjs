/*
 * The db_query grammar (phase 3 of the seat-access fence):
 * an ALLOW-LIST. Every operation, stage and operator must be named here;
 * anything else — $where, $function, $accumulator, $out, $merge, $graphLookup,
 * $changeStream, $currentOp, $collStats, any future stage — is refused without
 * being listed. Filters, projections and pipelines are validated recursively,
 * nested $lookup/$unionWith/$facet pipelines included, and every database and
 * collection a request reaches must be granted.
 */

export const OPERATIONS = Object.freeze(['find', 'count', 'distinct', 'aggregate', 'listCollections'])

const STAGES = new Set(['$match', '$project', '$addFields', '$set', '$unset', '$sort', '$limit', '$skip', '$count', '$group',
  '$unwind', '$sortByCount', '$bucket', '$bucketAuto', '$facet', '$lookup', '$unionWith', '$replaceRoot', '$replaceWith', '$sample'])

const OPERATORS = new Set([
  // comparison and logical
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$cmp', '$and', '$or', '$nor', '$not',
  // element and evaluation that runs no code
  '$exists', '$type', '$regex', '$options', '$mod', '$expr',
  // array
  '$all', '$elemMatch', '$size', '$arrayElemAt', '$concatArrays', '$filter', '$first', '$last', '$indexOfArray', '$isArray',
  '$map', '$reduce', '$reverseArray', '$slice', '$zip', '$sortArray', '$maxN', '$minN', '$firstN', '$lastN', '$range',
  '$arrayToObject', '$objectToArray', '$setUnion', '$setIntersection', '$setDifference', '$setEquals', '$setIsSubset',
  '$anyElementTrue', '$allElementsTrue',
  // string
  '$concat', '$indexOfBytes', '$indexOfCP', '$ltrim', '$rtrim', '$trim', '$regexMatch', '$regexFind', '$regexFindAll',
  '$replaceOne', '$replaceAll', '$split', '$strLenBytes', '$strLenCP', '$strcasecmp', '$substr', '$substrBytes', '$substrCP',
  '$toLower', '$toUpper',
  // date
  '$dateAdd', '$dateDiff', '$dateFromParts', '$dateFromString', '$dateSubtract', '$dateToParts', '$dateToString', '$dateTrunc',
  '$dayOfMonth', '$dayOfWeek', '$dayOfYear', '$hour', '$isoDayOfWeek', '$isoWeek', '$isoWeekYear', '$millisecond', '$minute',
  '$month', '$second', '$week', '$year',
  // arithmetic
  '$abs', '$add', '$ceil', '$divide', '$exp', '$floor', '$ln', '$log', '$log10', '$multiply', '$pow', '$round', '$sqrt',
  '$subtract', '$trunc',
  // conditional and type
  '$cond', '$ifNull', '$switch', '$convert', '$toBool', '$toDate', '$toDecimal', '$toDouble', '$toInt', '$toLong',
  '$toObjectId', '$toString', '$isNumber',
  // accumulators and object helpers
  '$sum', '$avg', '$min', '$max', '$push', '$addToSet', '$count', '$stdDevPop', '$stdDevSamp', '$mergeObjects',
  '$literal', '$let', '$getField'
])

export class GrammarError extends Error {
  constructor (message) { super(message); this.code = 'GRAMMAR' }
}
const refuse = (message) => { throw new GrammarError(message) }

/** An expression or filter: every `$` key must be named; values recurse. */
function expression (value, where) {
  if (Array.isArray(value)) { value.forEach((v, i) => expression(v, `${where}[${i}]`)); return }
  if (!value || typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value)) {
    if (key.startsWith('$') && !OPERATORS.has(key)) refuse(`${where}: operator ${key} is not allowed`)
    if (!key.startsWith('$') && key.includes('\0')) refuse(`${where}: invalid field name`)
    expression(inner, `${where}.${key}`)
  }
}

/** A stage's own specification, then its expressions. */
function stage (spec, where, reach) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) refuse(`${where}: a stage is an object`)
  const keys = Object.keys(spec)
  if (keys.length !== 1) refuse(`${where}: a stage has exactly one key`)
  const [name] = keys
  const body = spec[name]
  if (!STAGES.has(name)) refuse(`${where}: stage ${name} is not allowed`)
  switch (name) {
    case '$lookup': {
      if (!body || typeof body !== 'object') refuse(`${where}: $lookup needs a specification`)
      const extra = Object.keys(body).filter((k) => !['from', 'localField', 'foreignField', 'as', 'let', 'pipeline'].includes(k))
      if (extra.length) refuse(`${where}: $lookup does not take ${extra.join(', ')}`)
      reach(body.from, `${where}.$lookup.from`)
      if (body.let) expression(body.let, `${where}.$lookup.let`)
      if (body.pipeline) pipeline(body.pipeline, `${where}.$lookup.pipeline`, reach)
      return
    }
    case '$unionWith': {
      const spec2 = typeof body === 'string' ? { coll: body } : body
      if (!spec2 || typeof spec2 !== 'object') refuse(`${where}: $unionWith needs a specification`)
      const extra = Object.keys(spec2).filter((k) => !['coll', 'pipeline'].includes(k))
      if (extra.length) refuse(`${where}: $unionWith does not take ${extra.join(', ')}`)
      reach(spec2.coll, `${where}.$unionWith.coll`)
      if (spec2.pipeline) pipeline(spec2.pipeline, `${where}.$unionWith.pipeline`, reach)
      return
    }
    case '$facet': {
      if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(`${where}: $facet takes named pipelines`)
      for (const [facet, p] of Object.entries(body)) pipeline(p, `${where}.$facet.${facet}`, reach)
      return
    }
    case '$sort': {
      if (!body || typeof body !== 'object') refuse(`${where}: $sort takes fields`)
      for (const [field, dir] of Object.entries(body)) if (![1, -1].includes(dir)) refuse(`${where}: $sort.${field} must be 1 or -1`)
      return
    }
    case '$limit': case '$skip':
      if (!Number.isInteger(body) || body < 0) refuse(`${where}: ${name} takes a non-negative integer`)
      return
    case '$count': case '$unset':
      if (typeof body !== 'string' && !(Array.isArray(body) && body.every((b) => typeof b === 'string'))) refuse(`${where}: ${name} takes field names`)
      return
    case '$sample':
      if (!body || !Number.isInteger(body.size) || Object.keys(body).length !== 1) refuse(`${where}: $sample takes {size}`)
      return
    case '$unwind':
      if (typeof body === 'string') return
      if (!body || typeof body !== 'object') refuse(`${where}: $unwind takes a path`)
      if (Object.keys(body).some((k) => !['path', 'includeArrayIndex', 'preserveNullAndEmptyArrays'].includes(k))) refuse(`${where}: $unwind takes path, includeArrayIndex, preserveNullAndEmptyArrays`)
      return
    case '$bucket': case '$bucketAuto': {
      if (!body || typeof body !== 'object') refuse(`${where}: ${name} needs a specification`)
      const allowed = name === '$bucket' ? ['groupBy', 'boundaries', 'default', 'output'] : ['groupBy', 'buckets', 'output', 'granularity']
      const extra = Object.keys(body).filter((k) => !allowed.includes(k))
      if (extra.length) refuse(`${where}: ${name} does not take ${extra.join(', ')}`)
      expression(body.groupBy, `${where}.${name}.groupBy`)
      if (body.output) expression(body.output, `${where}.${name}.output`)
      return
    }
    default:
      expression(body, `${where}.${name}`)
  }
}

function pipeline (value, where, reach) {
  if (!Array.isArray(value)) refuse(`${where}: a pipeline is a list of stages`)
  if (value.length > 50) refuse(`${where}: at most 50 stages`)
  value.forEach((s, i) => stage(s, `${where}[${i}]`, reach))
}

/**
 * Validate a request against the grammar and the grant's reach.
 *
 * @param request  { op, database, collection?, filter?, projection?, sort?, limit?, skip?, field?, pipeline? }
 * @param allowed  (database, collection) => boolean — the grant
 */
export function validateQuery (request, allowed) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) refuse('a query is an object')
  const known = ['op', 'database', 'collection', 'filter', 'projection', 'sort', 'limit', 'skip', 'field', 'pipeline']
  const extra = Object.keys(request).filter((k) => !known.includes(k))
  if (extra.length) refuse(`unknown query field(s): ${extra.join(', ')}`)
  const { op, database, collection } = request
  if (!OPERATIONS.includes(op)) refuse(`op must be one of ${OPERATIONS.join(', ')}`)
  if (typeof database !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(database)) refuse('database must be a name')
  // `#` and `@` belong to a plain name: applications keep sidecar collections beside their own (`jobs#versions`,
  // `jobs#versions@<id>`), and a history audit reads exactly those. The name goes to the driver as a value, never
  // into a string, and the grant still decides: a grant that lists collections admits a sidecar only by its own name.
  const reach = (coll, where) => {
    if (typeof coll !== 'string' || !/^[A-Za-z0-9_.#@-]{1,120}$/.test(coll) || coll.startsWith('system.')) refuse(`${where}: collection must be a plain name`)
    if (!allowed(database, coll)) refuse(`${where}: collection ${database}.${coll} is not granted`)
  }
  if (op === 'listCollections') {
    if (!allowed(database, null)) refuse(`database ${database} is not granted`)
    return { op, database }
  }
  reach(collection, 'collection')
  if (request.filter !== undefined) expression(request.filter, 'filter')
  if (request.projection !== undefined) expression(request.projection, 'projection')
  if (request.sort !== undefined) stage({ $sort: request.sort }, 'sort', reach)
  for (const k of ['limit', 'skip']) if (request[k] !== undefined && (!Number.isInteger(request[k]) || request[k] < 0)) refuse(`${k} must be a non-negative integer`)
  if (op === 'distinct' && (typeof request.field !== 'string' || !request.field || request.field.startsWith('$'))) refuse('distinct needs a field')
  if (op === 'aggregate') pipeline(request.pipeline, 'pipeline', reach)
  else if (request.pipeline !== undefined) refuse('pipeline applies to aggregate only')
  return request
}
