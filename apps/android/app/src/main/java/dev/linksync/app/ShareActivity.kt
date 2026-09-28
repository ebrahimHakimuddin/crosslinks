package dev.linksync.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.Window
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors
import java.util.UUID

/** A compact share target: sending a link should not open the full dashboard. */
class ShareActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: CredentialStore
    private val api = LinkSyncApi()
    private lateinit var sendController: SendController
    private lateinit var operations: SendOperationStore
    private lateinit var content: LinearLayout
    private lateinit var articles: ArticleStore
    private var destroyed = false
    private var actionInFlight = false
    private var generation = 0L
    private var actionUrl: String? = null
    private var actionKey: String? = null
    private var actionScope: String? = null
    private var actionTarget: String? = null
    private var actionAccepted = false
    private var actionId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        store = CredentialStore(this)
        articles = ArticleStore(this)
        operations = SendOperationStore(this)
        sendController = SendController(operations, api)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(22), dp(24), dp(18))
            background = Brand.card(this@ShareActivity, 24)
        }
        setContentView(content)
        window.setBackgroundDrawableResource(android.R.color.transparent)
        window.setLayout((resources.displayMetrics.widthPixels * .92f).toInt(), -2)
        window.setGravity(Gravity.CENTER)
        setFinishOnTouchOutside(true)
        actionUrl = savedInstanceState?.getString("share_url") ?: readUrl()
        actionKey = savedInstanceState?.getString("share_key")
        actionScope = savedInstanceState?.getString("share_scope")
        actionTarget = savedInstanceState?.getString("share_target")
        actionAccepted = savedInstanceState?.getBoolean("share_accepted", false) ?: false
        actionId = savedInstanceState?.getString("share_action_id")
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("share_url", actionUrl)
        outState.putString("share_key", actionKey)
        outState.putString("share_scope", actionScope)
        outState.putString("share_target", actionTarget)
        outState.putBoolean("share_accepted", actionAccepted)
        outState.putString("share_action_id", actionId)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        generation++
        actionInFlight = false
        actionAccepted = false
        actionUrl = readUrl()
        actionKey = null
        actionScope = null
        actionTarget = null
        actionId = null
        render()
    }

    override fun onDestroy() {
        destroyed = true
        generation++
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun render() {
        val url = actionUrl ?: return finishWithMessage("CrossLinks only accepts HTTP or HTTPS links")
        val credentials = store.load() ?: return showPairPrompt(url)
        if (actionKey != null && actionScope != SendAction.scope(credentials)) {
            actionKey = null; actionScope = null; actionId = null; actionAccepted = false
        }
        content.removeAllViews()
        content.addView(TextView(this).apply {
            text = "Send with CrossLinks"
            textSize = 22f
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
            setTextColor(Brand.text(this@ShareActivity))
        })
        content.addView(Brand.secondary(Button(this).apply {
            text = "Save on this phone"
            setOnClickListener { runCatching { articles.save(url) }.onSuccess { statusMessage("Saved on this phone"); scheduleSync() }.onFailure { statusMessage("Could not save locally; your existing saved data is preserved") } }
        }), LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        content.addView(TextView(this).apply {
            text = url
            textSize = 14f
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            setTextColor(Brand.muted(this@ShareActivity))
            setPadding(0, dp(8), 0, dp(16))
        })
        val status = TextView(this).apply { setTextColor(Brand.muted(this@ShareActivity)) }
        content.addView(status)
        background(
            work = { api.devices(credentials) },
            success = { devices ->
                if (devices.isEmpty()) {
                    status.text = "No Chrome devices are paired yet."
                } else {
                    devices.forEach { device ->
                        content.addView(Brand.primary(Button(this)).apply {
                            tag = "target-${device.id}"
                            text = if (device.online) "${device.name}  ·  online" else "${device.name}  ·  queued"
                            isEnabled = actionTarget == null || actionTarget == device.id
                            setOnClickListener {
                                if (actionInFlight) return@setOnClickListener
                                if (actionAccepted) return@setOnClickListener
                                if (actionTarget != null && actionTarget != device.id) return@setOnClickListener
                                actionInFlight = true
                                val action = generation
                                setTargetsEnabled(false)
                                status.text = "Preparing send…"
                                val currentActionId = actionId ?: UUID.randomUUID().toString()
                                val binding = runCatching { SendAction.bind(operations, credentials, url, device.id, actionKey, currentActionId) }.getOrElse {
                                    actionInFlight = false; setTargetsEnabled(true); status.text = it.message ?: "Could not prepare send"; return@setOnClickListener
                                }
                                actionId = binding.actionId
                                actionKey = binding.key
                                actionScope = binding.scope
                                actionTarget = binding.target
                                actionUrl = binding.url
                                background(
                                    work = {
                                        binding to SendAction.submit(sendController, credentials, binding)
                                    },
                                    success = { (binding, accepted) -> if (action == generation) {
                                        actionKey = binding.key; actionScope = binding.scope; actionTarget = binding.target; actionUrl = url
                                        if (accepted.deliveryId == null && (accepted.state.equals("failed", true) || accepted.state.equals("expired", true))) {
                                            status.text = DeliveryText.forOperation(accepted)
                                            actionInFlight = false; setTargetsEnabled(false)
                                        } else if (accepted.deliveryId == null) {
                                            status.text = DeliveryText.forOperation(accepted)
                                            actionInFlight = false; setTargetsEnabled(true)
                                        } else {
                                            actionAccepted = true
                                            status.text = DeliveryText.forOperation(accepted)
                                            // Accepted actions keep all send buttons disabled.
                                            actionInFlight = false; setTargetsEnabled(false)
                                            addRefreshButton(status, credentials, accepted.key)
                                        }
                                    } },
                                    failure = { error -> if (action == generation) {
                                        (error as? SendActionTransportException)?.binding?.let { actionKey = it.key; actionScope = it.scope; actionUrl = it.url }
                                        status.text = if (error is SendActionTransportException) "Submission uncertain; retry" else error.message ?: "Failed"
                                        actionInFlight = false; setTargetsEnabled(true)
                                    } },
                                )
                            }
                        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
                    }
                    content.addView(Brand.secondary(Button(this)).apply {
                        text = "Open CrossLinks"
                        setOnClickListener { startActivity(Intent(this@ShareActivity, MainActivity::class.java).apply { action = Intent.ACTION_SEND; type = "text/plain"; putExtra(Intent.EXTRA_TEXT, url) }) }
                    }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
                    if (actionAccepted) setTargetsEnabled(false)
                    content.addView(Brand.secondary(Button(this)).apply { text = "Cancel"; setOnClickListener { finish() } }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
                }
            },
            failure = { error -> status.text = error.message ?: "Could not reach CrossLinks" },
        )
    }

    private fun showPairPrompt(url: String) {
        content.removeAllViews()
        content.addView(TextView(this).apply { text = "CrossLinks isn't paired"; textSize = 21f; setTextColor(Brand.text(this@ShareActivity)) })
        content.addView(TextView(this).apply { text = "Open CrossLinks to pair this phone before sending."; setTextColor(Brand.muted(this@ShareActivity)); setPadding(0, dp(8), 0, dp(12)) })
        content.addView(Brand.primary(Button(this)).apply {
            text = "Open CrossLinks"
            setOnClickListener { startActivity(Intent(this@ShareActivity, MainActivity::class.java).apply { action = Intent.ACTION_SEND; type = "text/plain"; putExtra(Intent.EXTRA_TEXT, url) }); finish() }
        })
        content.addView(Brand.secondary(Button(this).apply { text = "Save on this phone"; setOnClickListener { runCatching { articles.save(url) }.onSuccess { statusMessage("Saved on this phone"); scheduleSync() }.onFailure { statusMessage("Could not save locally; your existing saved data is preserved") } } }), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        content.addView(Brand.secondary(Button(this)).apply { text = "Cancel"; setOnClickListener { finish() } }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
    }

    private fun readUrl(): String? = runCatching {
        val raw = when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            else -> null
        } ?: return null
        validateSharedUrl(raw)
    }.getOrNull()

    private fun finishWithMessage(message: String) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
        finish()
    }

    private fun setTargetsEnabled(enabled: Boolean) {
        for (index in 0 until content.childCount) {
            val view = content.getChildAt(index)
            view.isEnabled = if (enabled && view.tag is String && (view.tag as String).startsWith("target-")) {
                actionTarget == null || (view.tag as String) == "target-$actionTarget"
            } else enabled
        }
    }
    private fun addRefreshButton(status: TextView, credentials: Credentials, key: String) {
        if (content.findViewWithTag<View>("refresh-$key") != null) return
        content.addView(Brand.secondary(Button(this).apply {
            tag = "refresh-$key"
            text = "Refresh delivery status"
            setOnClickListener {
                isEnabled = false
                background(
                    work = { sendController.refresh(credentials, key) },
                    success = { updated -> status.text = "Delivery ${updated.state}"; isEnabled = true },
                    failure = { error -> status.text = error.message ?: "Could not refresh delivery"; isEnabled = true },
                )
            }
        }), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
    }
    private fun statusMessage(message: String) { if (!destroyed) android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show() }
    private fun scheduleSync() { store.load()?.let { credentials -> if (runCatching { ArticleSync(this).enabled }.getOrDefault(false)) worker.execute { ArticleSync(this).sync(credentials) } } }

    private fun <T> background(work: () -> T, success: (T) -> Unit, failure: (Throwable) -> Unit) {
        val capturedGeneration = generation
        worker.execute {
            runCatching(work)
                .onSuccess { value -> main.post { if (isCurrentGeneration(capturedGeneration, generation, destroyed)) success(value) } }
                .onFailure { error -> main.post { if (isCurrentGeneration(capturedGeneration, generation, destroyed)) failure(error) } }
        }
    }

    companion object {
        internal fun isCurrentGeneration(captured: Long, current: Long, destroyed: Boolean): Boolean = !destroyed && captured == current
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
