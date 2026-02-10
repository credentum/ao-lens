-- Expected: STATE_FROZEN_NOT_INITIALIZED
-- State.Frozen is checked but never initialized
local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner
  -- Missing: Frozen = false
}

Handlers.add("Update", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Frozen then return false end  -- Using nil Frozen!
  return true
end, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  ao.send({ Target = msg.From, Data = "OK" })
end)
