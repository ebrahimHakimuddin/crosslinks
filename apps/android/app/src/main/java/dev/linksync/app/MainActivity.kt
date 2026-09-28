package dev.linksync.app

import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.UUID

class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: CredentialStore
    private lateinit var articles: ArticleStore
    private lateinit var operations: SendOperationStore
    private lateinit var sendController: SendController
    private lateinit var articleSync: ArticleSync
    private val api = LinkSyncApi()
    private var incomingUrl: String? = null
    private var incomingTarget: String? = null
    private var incomingOperationKey: String? = null
    private var incomingScope: String? = null
    private var incomingActionId: String? = null
    private var pairingPayload: PairingPayload? = null
    private var actionGeneration = 0L
    private var sharedToggleEpoch = 0L
    private var destroyed = false
    private var acceptedIncoming = false

    companion object {
        private const val STATE_URL = "incoming_url"
        private const val STATE_SCOPE = "incoming_scope"
        private const val STATE_KEY = "incoming_operation_key"
        private const val STATE_ACCEPTED = "incoming_accepted"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = CredentialStore(this)
        articles = ArticleStore(this)
        operations = SendOperationStore(this)
        sendController = SendController(operations, api)
        articleSync = ArticleSync(this, api)
        incomingUrl = savedInstanceState?.getString(STATE_URL) ?: readIncomingUrl(intent)
        acceptedIncoming = savedInstanceState?.getBoolean(STATE_ACCEPTED, false) ?: false
        incomingTarget = savedInstanceState?.getString("incoming_target")
        incomingOperationKey = savedInstanceState?.getString(STATE_KEY)
        incomingScope = savedInstanceState?.getString(STATE_SCOPE)
        incomingActionId = savedInstanceState?.getString("incoming_action_id")
        if (incomingOperationKey != null && incomingScope != currentScope()) {
            incomingOperationKey = null
            incomingScope = null
            acceptedIncoming = false
        }
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_URL, incomingUrl)
        outState.putBoolean(STATE_ACCEPTED, acceptedIncoming)
        outState.putString("incoming_target", incomingTarget)
        outState.putString(STATE_SCOPE, incomingScope)
        outState.putString(STATE_KEY, incomingOperationKey)
        outState.putString("incoming_action_id", incomingActionId)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        actionGeneration++
        acceptedIncoming = false
        incomingUrl = readIncomingUrl(intent)
        incomingTarget = null
        incomingOperationKey = null
        incomingScope = null
        incomingActionId = null
        render()
    }

    override fun onResume() {
        super.onResume()
        if (::articleSync.isInitialized) store.load()?.let { credentials -> worker.execute { articleSync.sync(credentials) } }
    }

    override fun onDestroy() {
        destroyed = true
        actionGeneration++
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun render() {
        setContentView(if (store.load() == null) pairingView() else homeView())
    }

    private fun root(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(24), dp(28), dp(24), dp(28))
        addView(brandHeader(), margins().apply { bottomMargin = dp(28) })
    }

    private fun brandHeader(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(android.widget.ImageView(this@MainActivity).apply { setImageResource(R.mipmap.ic_launcher) }, LinearLayout.LayoutParams(dp(40), dp(40)))
        addView(Brand.wordmark(TextView(this@MainActivity)), LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(10) })
    }

    private fun pairingView(): View = scroll(root().apply {
        addView(secondaryButton("Open saved links") { setContentView(libraryView()) }, margins(bottom = 18))
        addView(title("Pair CrossLinks"))
        addView(copy("Scan the QR code created by your CrossLinks server, or enter its details manually."))
        val scan = primaryButton("Scan pairing QR") { scanPairingCode() }
        addView(scan, margins(top = 22))
        addView(section("Manual pairing"), margins(top = 26))
        val server = input("https://links.example.com")
        val code = input("ABCDE-FGHIJ")
        val name = input(android.os.Build.MODEL.ifBlank { "Android phone" })
        addView(label("Server URL")); addView(server)
        addView(label("Pairing code"), margins(top = 14)); addView(code)
        addView(label("Device name"), margins(top = 14)); addView(name)
        val status = statusText()
        addView(primaryButton("Pair phone") {
            runCatching { PairingPayload.manual(code.text.toString(), server.text.toString()) }
                .onSuccess { pair(it, name.text.toString(), status) }
                .onFailure { status.error(it.message ?: "Invalid pairing details") }
        }, margins(top = 20))
        addView(status, margins(top = 12))
    })

    private fun homeView(): View = scroll(root().apply {
        val credentials = store.load() ?: return@apply
        addView(title("Send with CrossLinks"))
        addView(secondaryButton("Open saved links") { setContentView(libraryView()) }, margins(top = 12))
        addView(copy("Paired as ${credentials.deviceName}"))
        val sharedLibrary = Brand.tint(android.widget.Switch(this@MainActivity)).apply { text = "Share saved links with this paired server"; isChecked = articleSync.enabled }
        addView(sharedLibrary, margins(top = 12))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (roleManager?.isRoleAvailable(RoleManager.ROLE_BROWSER) == true && !roleManager.isRoleHeld(RoleManager.ROLE_BROWSER)) {
                addView(secondaryButton("Use CrossLinks for web links") {
                    startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_BROWSER), 40)
                }, margins(top = 18))
            }
        }

        val shared = incomingUrl
        if (shared != null) {
            addView(section("Link"), margins(top = 24))
            addView(copy(shared))
        } else {
            addView(copy("Choose CrossLinks from Android's Share or Open with menu to send a URL."), margins(top = 24))
        }

        addView(section("Target browser"), margins(top = 24))
        val targets = RadioGroup(this@MainActivity).apply {
            orientation = RadioGroup.VERTICAL
            background = Brand.card(this@MainActivity)
            setPadding(dp(12), dp(6), dp(12), dp(6))
        }
        addView(targets, margins(top = 8))
        val status = statusText()
        lateinit var send: Button
        send = primaryButton("Send link") {
            val selected = targets.findViewById<RadioButton>(targets.checkedRadioButtonId)?.tag as? String
            if (shared == null) status.error("Open or share a URL with CrossLinks first")
            else if (selected == null) status.error("Choose a target browser")
            else if (acceptedIncoming) status.text = "Opened/delivered"
            else { send(shared, selected, status, send, targets) }
        }.apply { isEnabled = false }
        addView(send, margins(top = 16))
        addView(status, margins(top = 10))
        addView(secondaryButton("Refresh shared library") { status.text = "Refreshing library…"; background(work = { articleSync.sync(credentials) }, success = { status.text = articleSync.lastError?.let { "Library refresh failed: $it" } ?: "Library refreshed" }, failure = { error -> status.error(error.message ?: "Library sync failed") }) }, margins(top = 10))
        sharedLibrary.setOnCheckedChangeListener { _, checked ->
            val epoch = ++sharedToggleEpoch
            if (checked) {
                val request = runCatching { articleSync.reserveEnable(credentials) }.getOrElse {
                    sharedLibrary.isChecked = false
                    status.error(it.message ?: "Could not enable shared library")
                    return@setOnCheckedChangeListener
                }
                status.text = "Enabling shared library…"
                background(
                    work = { articleSync.completeEnable(request) },
                    success = { completed ->
                        if (epoch != sharedToggleEpoch || !sharedLibrary.isChecked) return@background
                        if (completed && articleSync.enabled && articleSync.lastError == null) status.text = "Shared library enabled"
                        else { sharedLibrary.isChecked = false; status.error(articleSync.lastError ?: "Could not enable shared library") }
                    },
                    failure = { error ->
                        if (epoch != sharedToggleEpoch) return@background
                        sharedLibrary.isChecked = false
                        status.error(error.message ?: "Could not enable shared library")
                    },
                )
            } else {
                articleSync.disable()
                status.text = "Shared library disabled; local links remain"
            }
        }
        addView(secondaryButton("Check for updates") {
            status.text = "Checking versions…"
            background(
                work = { api.versions(credentials) },
                success = { versions ->
                    val app = appVersion()
                    val health = if (app == versions.android && versions.android == versions.extension) "All components match" else "A component update may be available"
                    status.text = "$health · app $app · server ${versions.server} · extension ${versions.extension}"
                },
                failure = { status.error(it.message ?: "Could not check versions") },
            )
        }, margins(top = 16))
        addView(section("Recent history"), margins(top = 28))
        val history = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            background = Brand.card(this@MainActivity)
            setPadding(dp(16), dp(6), dp(16), dp(6))
        }
        addView(history, margins(top = 8))
        addView(secondaryButton("Forget this server") {
            articleSync.disable(); store.clear(); pairingPayload = null; incomingUrl = null; render()
        }, margins(top = 28))

        background(
            work = { api.devices(credentials) to api.history(credentials) },
                success = { (devices, items) ->
                if (destroyed) return@background
                targets.removeAllViews()
                devices.forEach { device ->
                    targets.addView(Brand.tint(RadioButton(this@MainActivity)).apply {
                        minHeight = dp(48)
                        id = View.generateViewId()
                        tag = device.id
                        text = if (device.online) "${device.name} · online" else "${device.name} · offline, will queue"
                        if (device.id == (incomingTarget ?: store.lastTargetId)) isChecked = true
                    })
                }
                if (targets.checkedRadioButtonId == -1 && targets.childCount > 0) {
                    (targets.getChildAt(0) as RadioButton).isChecked = true
                }
                if (incomingOperationKey != null && incomingTarget != null) {
                    for (index in 0 until targets.childCount) targets.getChildAt(index).isEnabled = false
                }
                send.isEnabled = devices.isNotEmpty() && shared != null && !acceptedIncoming
                history.removeAllViews()
                if (items.isEmpty()) history.addView(copy("Nothing sent yet."))
                items.take(12).forEach { item -> history.addView(historyRow(item)) }
                operations.all().filter { it.scope == "${credentials.endpoints.joinToString(",")}::${credentials.deviceId}" }.takeLast(8).forEach { operation ->
                    val row = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(8), 0, dp(8)) }
                    row.addView(copy("${operation.state}: ${operation.url}"))
                    if (operation.deliveryId != null) row.addView(secondaryButton("Refresh delivery status") {
                        background(work = { sendController.refresh(credentials, operation.key) }, success = { updated -> status.text = "Delivery ${updated.state}" }, failure = { error -> status.error(error.message ?: "Could not refresh delivery") })
                    }) else if (operations.retryable(operation)) row.addView(secondaryButton("Retry submission") {
                        background(work = { sendController.retry(credentials, operation.key) }, success = { updated -> status.text = "${updated.state}: ${updated.deliveryId ?: "pending"}" }, failure = { error -> status.error(error.message ?: "Retry failed") })
                    })
                    history.addView(row)
                }
            },
            failure = { if (!destroyed) status.error(it.message ?: "Could not reach the server") },
        )
    })

    private fun scanPairingCode() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        try {
            GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { barcode ->
                    runCatching { PairingPayload.parse(barcode.rawValue ?: "") }
                        .onSuccess { payload ->
                            pairingPayload = payload
                            showScannedPairing(payload)
                        }
                        .onFailure { showMessage(it.message ?: "That QR code is not a CrossLinks pairing code") }
                }
                .addOnFailureListener { showMessage(it.message ?: "QR scanning failed") }
        } catch (error: RuntimeException) {
            // Google Play services can fail before returning a Task when the
            // optional scanner module is unavailable or the device has no
            // compatible Play services. Keep that device-side failure from
            // taking down the app and let the user use manual pairing.
            showMessage(error.message ?: "QR scanning is unavailable on this device")
        }
    }

    private fun showScannedPairing(payload: PairingPayload) {
        val layout = root()
        layout.addView(title("Confirm pairing"))
        layout.addView(copy("Server: ${payload.endpoints.first()}"))
        val name = input(android.os.Build.MODEL.ifBlank { "Android phone" })
        layout.addView(label("Device name"), margins(top = 20)); layout.addView(name)
        val status = statusText()
        layout.addView(primaryButton("Pair phone") { pair(payload, name.text.toString(), status) }, margins(top = 20))
        layout.addView(status, margins(top = 12))
        layout.addView(secondaryButton("Cancel") { pairingPayload = null; render() }, margins(top = 12))
        setContentView(scroll(layout))
    }

    private fun pair(payload: PairingPayload, deviceName: String, status: TextView) {
        if (deviceName.trim().isEmpty()) return status.error("Enter a device name")
        status.setText(R.string.pairing_in_progress)
        background(
            work = { api.pair(payload, deviceName.trim()) },
            success = { credentials -> store.save(credentials); pairingPayload = null; render() },
            failure = { status.error(it.message ?: "Pairing failed") },
        )
    }

    private fun send(url: String, targetId: String, status: TextView, button: Button? = null, targets: RadioGroup? = null) {
        val credentials = store.load() ?: return render()
        val generation = actionGeneration
        button?.isEnabled = false
        targets?.let { group -> for (i in 0 until group.childCount) group.getChildAt(i).isEnabled = false }
        status.setText(R.string.sending_in_progress)
        val actionId = incomingActionId ?: UUID.randomUUID().toString()
        val binding = runCatching { SendAction.bind(operations, credentials, url, targetId, incomingOperationKey, actionId) }.getOrElse {
            status.error(it.message ?: "Could not prepare send")
            button?.isEnabled = true
            targets?.let { group -> for (index in 0 until group.childCount) group.getChildAt(index).isEnabled = true }
            return
        }
        incomingActionId = binding.actionId
        incomingOperationKey = binding.key
        incomingScope = binding.scope
        incomingTarget = binding.target
        background(
            work = {
                binding to SendAction.submit(sendController, credentials, binding)
            },
            success = { (_, accepted) ->
                if (generation != actionGeneration || destroyed) return@background
                incomingOperationKey = accepted.key
                incomingScope = accepted.scope
                incomingTarget = targetId
                store.lastTargetId = targetId
                if (accepted.deliveryId != null) {
                    acceptedIncoming = true
                    status.text = DeliveryText.forOperation(accepted)
                    button?.isEnabled = false
                } else if (accepted.state.equals("failed", true) || accepted.state.equals("expired", true)) {
                    status.text = DeliveryText.forOperation(accepted)
                    button?.isEnabled = false
                } else {
                    status.text = DeliveryText.forOperation(accepted)
                    button?.isEnabled = true
                }
            },
            failure = { error -> if (generation == actionGeneration && !destroyed) { (error as? SendActionTransportException)?.binding?.let { incomingOperationKey = it.key; incomingScope = it.scope; incomingTarget = it.target }; status.error(if (error is SendActionTransportException) DeliveryText.forOperation(operations.load(incomingOperationKey!!) ?: SendOperation("missing", url, targetId), uncertain = true) else error.message ?: "Failed"); button?.isEnabled = true } },
        )
    }

    private fun libraryView(): View = scroll(root().apply {
        addView(title("Saved links"))
        addView(copy("Links and reading positions stay on this phone unless you turn on shared sync."), margins(bottom = 14))
        val search = input("Search saved links")
        addView(search)
        var cachedLists = listOf("All lists") + runCatching { articles.lists() }.getOrDefault(emptyList())
        var updatingSpinner = false
        val listFilter = android.widget.Spinner(this@MainActivity).apply { adapter = android.widget.ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, cachedLists) }
        addView(listFilter, margins(top = 8))
        val readFilter = RadioGroup(this@MainActivity).apply { orientation = RadioGroup.HORIZONTAL }
        listOf("All", "Unread", "Read").forEach { value -> readFilter.addView(RadioButton(this@MainActivity).apply { text = value; tag = value; minHeight = dp(48) }) }
        (readFilter.getChildAt(0) as RadioButton).isChecked = true
        addView(readFilter)
        val rows = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
        addView(rows, margins(top = 16))
        fun refresh() {
            runCatching { rows.removeAllViews(); val q = search.text.toString().trim().lowercase(); val previousList = listFilter.selectedItem?.toString() ?: "All lists"; val latestLists = listOf("All lists") + runCatching { articles.lists() }.getOrDefault(emptyList()); if (latestLists != cachedLists) { cachedLists = latestLists; updatingSpinner = true; listFilter.adapter = android.widget.ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, cachedLists); listFilter.setSelection(cachedLists.indexOf(previousList).coerceAtLeast(0)); updatingSpinner = false }; val selectedList = listFilter.selectedItem?.toString(); val selectedRead = readFilter.findViewById<RadioButton>(readFilter.checkedRadioButtonId)?.tag as? String ?: "All"
            articles.all().filter { q.isEmpty() || it.title.lowercase().contains(q) || it.url.lowercase().contains(q) || it.snippet.lowercase().contains(q) }.filter { selectedList == "All lists" || it.list == selectedList }.filter { selectedRead == "All" || (selectedRead == "Read") == ((it.readAt ?: 0L) > 0L) }.forEach { article ->
                val row = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; background = Brand.card(this@MainActivity); setPadding(dp(14), dp(12), dp(14), dp(12)) }
                row.addView(copy(if (article.title.isBlank()) article.url else article.title))
                row.addView(copy("${article.list} · ${if ((article.readAt ?: 0L) > 0L) "Read" else "Unread"} · ${(article.progress * 100).toInt()}% position"))
                if (article.snippet.isNotBlank()) row.addView(copy("Passage: ${article.snippet}"))
                val controls = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL }
                controls.addView(secondaryButton("Open") { openArticle(article) }, LinearLayout.LayoutParams(0, -2, 1f))
                controls.addView(secondaryButton("Edit link") { showEditDialog(article, ::refresh) }, LinearLayout.LayoutParams(0, -2, 1f))
                controls.addView(secondaryButton(if ((article.readAt ?: 0L) == 0L) "Mark read" else "Mark unread") { runCatching { articles.markRead(article.id, (article.readAt ?: 0L) == 0L) }.onSuccess { scheduleArticleSync(); refresh() }.onFailure { showMessage("Could not update saved link; your data is preserved") } }, LinearLayout.LayoutParams(0, -2, 1f))
                controls.addView(secondaryButton("Delete") { android.app.AlertDialog.Builder(this@MainActivity).setTitle("Delete saved link?").setMessage(article.url).setNegativeButton("Cancel", null).setPositiveButton("Delete") { _, _ -> runCatching { articles.delete(article.id) }.onSuccess { scheduleArticleSync(); refresh() }.onFailure { showMessage("Could not delete saved link; your data is preserved") } }.show() }, LinearLayout.LayoutParams(0, -2, 1f))
                row.addView(controls)
                rows.addView(row, margins(top = 8))
            }
            if (rows.childCount == 0) rows.addView(copy("No saved links yet. Use Save link below.")) }.onFailure { rows.removeAllViews(); rows.addView(copy("Saved links could not be read: ${it.message ?: "storage error"}")) }
        }
        search.addTextChangedListener(object : android.text.TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { refresh() }; override fun afterTextChanged(s: android.text.Editable?) = Unit }); listFilter.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener { override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit; override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) { if (!updatingSpinner) refresh() } }; readFilter.setOnCheckedChangeListener { _, _ -> refresh() }
        addView(primaryButton("Save link") { showSaveDialog(::refresh) }, margins(top = 14))
        addView(secondaryButton("Back") { render() }, margins(top = 10)); refresh()
    })

    private fun showSaveDialog(refresh: () -> Unit) {
        val url = input("https://example.com/article"); val title = input("Title (optional)"); val list = input("List (optional)"); val snippet = input("Passage (optional)"); val progress = input("Reading position 0–100").apply { inputType = android.text.InputType.TYPE_CLASS_NUMBER }
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(12), dp(24), 0); addView(label("URL")); addView(url); addView(label("Title"), margins(top = 12)); addView(title); addView(label("List"), margins(top = 12)); addView(list); addView(label("Passage"), margins(top = 12)); addView(snippet); addView(label("Reading position (%)"), margins(top = 12)); addView(progress) }
        android.app.AlertDialog.Builder(this).setTitle("Save link").setView(box).setNegativeButton("Cancel", null).setPositiveButton("Save") { _, _ -> runCatching { articles.save(url.text.toString(), title.text.toString(), list.text.toString().ifBlank { "Inbox" }, snippet.text.toString(), ReadingPosition.fromPercent(progress.text.toString().toIntOrNull() ?: 0)) }.onSuccess { scheduleArticleSync(); refresh() }.onFailure { showMessage(it.message ?: "Could not save link; your saved data is preserved") } }.show()
    }

    private fun scheduleArticleSync() { if (::articleSync.isInitialized && articleSync.enabled) store.load()?.let { credentials -> worker.execute { articleSync.sync(credentials) } } }

    private fun showEditDialog(article: ArticleRecord, refresh: () -> Unit) {
        val title = input("Title").apply { setText(article.title) }
        val list = input("List").apply { setText(article.list) }
        val snippet = input("Passage").apply { setText(article.snippet) }
        val progress = input("Reading position 0–100").apply { inputType = android.text.InputType.TYPE_CLASS_NUMBER; setText(ReadingPosition.toPercent(article.progress).toString()) }
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(12), dp(24), 0); addView(label("Title")); addView(title); addView(label("List"), margins(top = 12)); addView(list); addView(label("Passage"), margins(top = 12)); addView(snippet); addView(label("Reading position (%)"), margins(top = 12)); addView(progress) }
        android.app.AlertDialog.Builder(this).setTitle("Edit saved link").setView(box).setNegativeButton("Cancel", null).setPositiveButton("Save") { _, _ -> runCatching { articles.update(article.copy(title = title.text.toString().take(300), list = list.text.toString().take(60).ifBlank { "Inbox" }, snippet = snippet.text.toString().take(500), progress = ReadingPosition.fromPercent(progress.text.toString().toIntOrNull() ?: 0))) }.onSuccess { scheduleArticleSync(); refresh() }.onFailure { showMessage("Could not update link; your data is preserved") } }.show()
    }

    private fun openArticle(article: ArticleRecord) {
        val url = TextFragmentRestore.restore(article.url, article.snippet)
        val query = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val chooser = BrowserSelection.chooser(this, url) ?: return showMessage("No external browser is available for this link")
        runCatching { startActivity(chooser) }.onFailure { showMessage("No external browser is available for this link") }
    }

    private fun readIncomingUrl(intent: Intent): String? {
        val raw = when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            else -> null
        } ?: return null
        return runCatching { validateSharedUrl(raw) }.getOrElse {
            main.post { showMessage(it.message ?: "CrossLinks only accepts complete HTTP or HTTPS URLs") }
            null
        }
    }

    private fun <T> background(work: () -> T, success: (T) -> Unit, failure: (Throwable) -> Unit) {
        worker.execute {
            runCatching(work).onSuccess { main.post { if (!destroyed) success(it) } }.onFailure { main.post { if (!destroyed) failure(it) } }
        }
    }

    private fun currentScope(): String? = store.load()?.let { "${it.endpoints.joinToString(",")}::${it.deviceId}" }

    private fun historyRow(item: HistoryItem): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(9), 0, dp(9))
        addView(TextView(this@MainActivity).apply {
            text = item.url; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            setTextColor(Brand.text(this@MainActivity))
        })
        addView(TextView(this@MainActivity).apply {
            text = getString(
                R.string.history_metadata,
                item.status,
                DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(item.createdAt)),
            )
            setTextColor(Brand.muted(this@MainActivity)); textSize = 12f
        })
    }

    private fun scroll(content: View): ScrollView = ScrollView(this).apply { addView(content) }
    private fun title(value: String) = TextView(this).apply {
        text = value; textSize = 28f; letterSpacing = -0.02f
        typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
        setTextColor(Brand.text(this@MainActivity)); setPadding(0, 0, 0, dp(6))
    }
    private fun section(value: String) = TextView(this).apply {
        text = value.uppercase(); textSize = 11f; letterSpacing = 0.09f
        typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
        setTextColor(Brand.muted(this@MainActivity))
    }
    private fun copy(value: String) = TextView(this).apply { text = value; textSize = 15f; setTextColor(Brand.muted(this@MainActivity)); setTextIsSelectable(true) }
    private fun label(value: String) = TextView(this).apply {
        text = value; textSize = 13f; setPadding(0, 0, 0, dp(6)); setTextColor(Brand.text(this@MainActivity))
        typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
    }
    private fun input(hintValue: String) = Brand.input(EditText(this)).apply { hint = hintValue; isSingleLine = true }
    private fun statusText() = TextView(this).apply { setTextColor(Brand.muted(this@MainActivity)); setTextIsSelectable(true) }
    private fun primaryButton(textValue: String, action: () -> Unit) = Brand.primary(Button(this)).apply { text = textValue; setOnClickListener { action() } }
    private fun secondaryButton(textValue: String, action: () -> Unit) = Brand.secondary(Button(this)).apply { text = textValue; setOnClickListener { action() } }
    private fun TextView.error(message: String) { text = message; setTextColor(Brand.danger(this@MainActivity)) }
    private fun showMessage(message: String) = if (!destroyed) android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show() else Unit
    private fun appVersion(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
    private fun margins(top: Int = 0, bottom: Int = 0): ViewGroup.MarginLayoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top); bottomMargin = dp(bottom) }
}
