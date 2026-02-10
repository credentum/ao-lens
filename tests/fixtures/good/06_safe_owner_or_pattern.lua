-- GOOD: State.Owner = State.Owner or X WITH assert
-- Expected: NO findings

State.Owner = State.Owner or ao.env.Process.Owner
assert(State.Owner ~= nil, "Owner not initialized")  -- Required assert!

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Assertion-based auth (fails closed)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Params = msg.Data
end)
