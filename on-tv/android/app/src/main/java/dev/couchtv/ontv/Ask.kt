package dev.couchtv.ontv

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * OPTIONAL "ask" hook. OFF by default. There is no Claude in on-TV mode unless the household adds
 * its own Anthropic API key on the setup page and switches "ask" on.
 *
 * Cost: each ask is a few model calls on Claude Haiku 5.5 (about US$0.10 per million input tokens
 * and US$0.50 per million output, Oct 2026). A typical "put on X" is around 12,000 input and 1,200
 * output tokens, so roughly a fifth of a US cent. Set a monthly spend limit on the key in the
 * Anthropic Console, and use a key made only for this TV: anyone with ADB access to the TV could
 * read it from the app's storage.
 *
 * Raw HTTPS to the Messages API, to keep the TV app small. Nothing here runs unless a key is set.
 */
object Ask {
    const val MODEL = "claude-haiku-5-5"
    private const val ENDPOINT = "https://api.anthropic.com/v1/messages"

    val enabled get() = Store.bool("ask_enabled") && !Store.str("ask_key").isNullOrEmpty()

    private val TOOLS = JSONArray()
        .put(tool("play", "Find a show or film and start it in the right streaming app on the TV.",
            JSONObject().put("title", str("Show or film name")).put("season", int()).put("episode", int()).put("service", str("Optional app id, for example netflix")), listOf("title")))
        .put(tool("launch", "Open an app on the TV by id (netflix, youtube, stan, abc-iview, disney-plus, prime-video, ...).",
            JSONObject().put("app", str("App id or Android package")), listOf("app")))
        .put(tool("key", "Press a remote key: up, down, left, right, ok, back, home, play_pause, volume_up, volume_down, mute.",
            JSONObject().put("key", str("Key name")), listOf("key")))
        .put(tool("now", "What is on the TV right now.", JSONObject(), emptyList()))

    fun ask(text: String, who: String?): JSONObject {
        val key = Store.str("ask_key") ?: throw ApiError(501, "Ask is off in on-TV mode.")
        val started = System.currentTimeMillis()
        val messages = JSONArray().put(JSONObject().put("role", "user").put("content", text))
        val actions = JSONArray()
        val system = "You control a TV through tools. Do what the person asks with the fewest tool calls, then reply in one or two short plain sentences. " +
            "Country: ${Store.country()}." + (who?.let { " Watching: $it." } ?: "")
        for (round in 0 until 5) {
            val body = JSONObject().put("model", MODEL).put("max_tokens", 1024).put("system", system)
                .put("tools", TOOLS).put("tool_choice", JSONObject().put("type", "auto"))
                .put("output_config", JSONObject().put("effort", "low")).put("messages", messages)
            val res = call(key, body)
            val content = res.getJSONArray("content")
            messages.put(JSONObject().put("role", "assistant").put("content", content))
            if (res.optString("stop_reason") != "tool_use") {
                val reply = (0 until content.length()).map { content.getJSONObject(it) }.filter { it.optString("type") == "text" }.joinToString(" ") { it.optString("text") }.trim()
                return JSONObject().put("ok", true).put("reply", reply.ifEmpty { "Done." }).put("actions", actions)
                    .put("seconds", (System.currentTimeMillis() - started) / 1000.0)
            }
            val results = JSONArray()
            for (i in 0 until content.length()) {
                val b = content.getJSONObject(i)
                if (b.optString("type") != "tool_use") continue
                val input = b.optJSONObject("input") ?: JSONObject()
                val (ok, out) = try { true to runTool(b.getString("name"), input, who) } catch (e: Exception) { false to (e.message ?: "failed") }
                actions.put(JSONObject().put("tool", b.getString("name")).put("args", input).put("ok", ok))
                results.put(JSONObject().put("type", "tool_result").put("tool_use_id", b.getString("id")).put("content", out).put("is_error", !ok))
            }
            messages.put(JSONObject().put("role", "user").put("content", results))
        }
        return JSONObject().put("ok", true).put("reply", "Done.").put("actions", actions).put("seconds", (System.currentTimeMillis() - started) / 1000.0)
    }

    private fun runTool(name: String, a: JSONObject, who: String?): String = when (name) {
        "play" -> Finder.play(a.getString("title"), a.optInt("season").takeIf { it > 0 }, a.optInt("episode").takeIf { it > 0 }, a.optString("service").ifEmpty { null }, who).toString()
        "launch" -> { val app = Apps.BY_ID[a.getString("app")]; Tv.launchPackage(app?.pkg ?: a.getString("app")); "opened" }
        "key" -> Tv.key(a.getString("key"))
        "now" -> Now.payload().toString()
        else -> throw IllegalArgumentException("unknown tool $name")
    }

    private fun call(key: String, body: JSONObject): JSONObject {
        val c = URL(ENDPOINT).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000; c.readTimeout = 60_000
        c.requestMethod = "POST"; c.doOutput = true
        c.setRequestProperty("content-type", "application/json")
        c.setRequestProperty("x-api-key", key)
        c.setRequestProperty("anthropic-version", "2023-06-01")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream).bufferedReader().readText()
        c.disconnect()
        if (code !in 200..299) throw ApiError(502, "Claude API error $code: " + (runCatching { JSONObject(text).getJSONObject("error").getString("message") }.getOrNull() ?: text.take(120)))
        return JSONObject(text)
    }

    private fun tool(name: String, desc: String, props: JSONObject, required: List<String>) = JSONObject().put("name", name).put("description", desc)
        .put("input_schema", JSONObject().put("type", "object").put("properties", props).put("required", JSONArray(required)))
    private fun str(d: String) = JSONObject().put("type", "string").put("description", d)
    private fun int() = JSONObject().put("type", "integer")
}
