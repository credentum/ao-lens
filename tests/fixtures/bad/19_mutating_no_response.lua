-- Expected: MUTATING_HANDLER_NO_RESPONSE
-- Update handler doesn't send confirmation
local json = require("json")

State = State or {
  Owner = ao.env.Process.Owner,
  Frozen = false,
  Value = nil
}

Handlers.add("Update",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    assert(msg.From == State.Owner, "Unauthorized")
    State.Value = msg.Data
    -- Missing ao.send() confirmation!
  end
)

-- Query handler with response - this is fine
Handlers.add("GetState",
  Handlers.utils.hasMatchingTag("Action", "GetState"),
  function(msg)
    ao.send({ Target = msg.From, Data = json.encode(State) })
  end
)
