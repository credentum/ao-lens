-- Test fixture for P0: hasMatchingTag-alone detection
-- Tests that hasMatchingTag matchers require handler body authorization

local json = require("json")

State = {
  Owner = nil,
  Value = nil,
  Frozen = false
}

-- VULNERABLE: hasMatchingTag + no handler auth
-- Should trigger: HASMATCHING_TAG_NO_HANDLER_AUTH (CRITICAL)
Handlers.add("BadUpdate",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    -- No authorization check in handler body!
    State.Value = json.decode(msg.Data)
  end
)

-- VULNERABLE: hasMatchingTag + no handler auth (different action)
-- Should trigger: HASMATCHING_TAG_NO_HANDLER_AUTH (CRITICAL)
Handlers.add("BadDelete",
  Handlers.utils.hasMatchingTag("Action", "Delete"),
  function(msg)
    State.Value = nil  -- Anyone can delete!
  end
)

-- SAFE: hasMatchingTag + handler body has assert auth
-- Should trigger: LOOSE_MATCHER_WITH_BODY_AUTH (LOW - informational)
Handlers.add("GoodUpdate",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    assert(msg.From == State.Owner, "Unauthorized")
    State.Value = json.decode(msg.Data)
  end
)

-- SAFE: hasMatchingTag + handler body has if check
-- Should trigger: LOOSE_MATCHER_WITH_BODY_AUTH (LOW - informational)
Handlers.add("GoodUpdateWithIf",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    if msg.From ~= State.Owner then
      ao.send({ Target = msg.From, Data = "Unauthorized" })
      return
    end
    State.Value = json.decode(msg.Data)
  end
)

-- SAFE: hasMatchingTag + handler body has nil-guarded auth
-- Should trigger: LOOSE_MATCHER_WITH_BODY_AUTH (LOW - informational)
Handlers.add("GoodUpdateNilGuarded",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    if State.Owner and msg.From and msg.From == State.Owner then
      State.Value = json.decode(msg.Data)
    end
  end
)

-- SAFE: hasMatchingTag but READ-ONLY handler (no state mutation)
-- Should NOT trigger any findings
Handlers.add("GetState",
  Handlers.utils.hasMatchingTag("Action", "GetState"),
  function(msg)
    ao.send({
      Target = msg.From,
      Data = json.encode(State)
    })
  end
)
