-- GOOD: json.encode wrapped in pcall
-- NotExpected: JSON_ENCODE_NO_PCALL

State = State or { History = {} }

local function safeJsonEncode(data)
  local ok, result = pcall(require("json").encode, data)
  if not ok then return nil, result end
  return result, nil
end

Handlers.add("GetHistory", { Action = "GetHistory" }, function(msg)
  local encoded, err = safeJsonEncode(State.History)
  if not encoded then
    ao.send({ Target = msg.From, Action = "Error", Data = err })
    return
  end
  ao.send({ Target = msg.From, Data = encoded })
end)
