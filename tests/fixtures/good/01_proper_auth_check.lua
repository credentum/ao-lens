-- GOOD: Handler with proper authorization check using assertions
-- Expected: NO findings

State = State or { Owner = "owner-address", Data = {} }

-- Using table matcher which validates Tags.Action exists
Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Proper assertion-based auth (fails closed)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
