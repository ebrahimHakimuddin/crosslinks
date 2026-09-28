package dev.linksync.app

import android.content.Context
import android.content.Intent
import android.content.ComponentName
import android.content.pm.ResolveInfo
import android.net.Uri

/** Pure helpers for choosing an external browser without ever selecting this app. */
object BrowserSelection {
    data class ExternalComponent(val packageName: String, val className: String)
    fun candidates(context: Context, url: String): List<ResolveInfo> {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        return context.packageManager.queryIntentActivities(intent, 0)
            .filter { it.activityInfo.packageName != context.packageName }
    }

    fun chooser(context: Context, url: String): Intent? {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val components = externalComponents(context.packageName, candidates(context, url))
        if (components.isEmpty()) return null
        val first = Intent(intent).setComponent(ComponentName(components.first().packageName, components.first().className))
        return Intent.createChooser(first, "Open link").apply {
            if (components.size > 1) putExtra(Intent.EXTRA_INITIAL_INTENTS, components.drop(1).map { Intent(intent).setComponent(ComponentName(it.packageName, it.className)) }.toTypedArray())
        }
    }

    fun externalComponents(ownPackage: String, values: List<ResolveInfo>): List<ExternalComponent> = values
        .filter { it.activityInfo.packageName != ownPackage }
        .distinctBy { "${it.activityInfo.packageName}/${it.activityInfo.name}" }
        .map { ExternalComponent(it.activityInfo.packageName, it.activityInfo.name) }
}

/** Restores a saved passage while retaining an existing fragment and avoiding duplicate directives. */
object TextFragmentRestore {
    fun restore(url: String, snippet: String): String {
        if (snippet.isBlank() || Regex("(?i)(^|#).*:~:text=").containsMatchIn(url)) return url
        val encoded = encode(snippet.replace('\n', ' ').trim().take(500))
        if (encoded.isBlank()) return url
        val separator = if (url.contains('#')) "" else "#"
        return "$url${separator}:~:text=$encoded"
    }

    private fun encode(value: String): String = buildString {
        value.toByteArray(Charsets.UTF_8).forEach { byte ->
            val c = byte.toInt() and 0xff
            if ((c in 'a'.code..'z'.code) || (c in 'A'.code..'Z'.code) || (c in '0'.code..'9'.code) || c in "._~".map { it.code }) {
                append(c.toChar())
            } else append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 15])
        }
    }
}
