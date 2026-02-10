-- BAD: json.encode without pcall wrapper
-- Expected: JSON_ENCODE_NO_PCALL (high) at line 9

State = State or { History = {} }

Handlers.add("GetHistory", { Action = "GetHistory" }, function(msg)
  ao.send({
    Target = msg.From,
    Data = require("json").encode(State.History)  -- NO pcall!
  })
end)
