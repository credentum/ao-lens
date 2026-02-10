-- GOOD: State.Owner = nil but set via conditional assignment
-- Expected: NO findings

-- Owner initialized to nil but set from ao.env on first access
State = State or { Owner = nil, Data = {} }
if not State.Owner then State.Owner = ao.env.Process.Owner end

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Assertion-based auth (fails closed)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Data = msg.Data
end)
