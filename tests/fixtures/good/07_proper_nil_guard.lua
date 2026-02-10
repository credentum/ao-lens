-- GOOD: msg.From == State.Owner with proper nil guards
-- NotExpected: NIL_GUARD_REQUIRED

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Assertion-based auth (fails closed)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Data = msg.Data
end)
