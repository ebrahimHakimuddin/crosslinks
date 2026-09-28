package dev.linksync.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences("linksync", Context.MODE_PRIVATE)

    fun load(): Credentials? {
        val encrypted = preferences.getString(CREDENTIALS, null) ?: return null
        return runCatching {
            val json = JSONObject(decrypt(encrypted))
            Credentials(
                endpoints = json.getJSONArray("endpoints").let { array -> List(array.length()) { array.getString(it) } },
                token = json.getString("token"),
                deviceId = json.getString("deviceId"),
                deviceName = json.getString("deviceName"),
            )
        }.getOrNull()
    }

    fun save(credentials: Credentials) {
        val json = JSONObject()
            .put("endpoints", JSONArray(credentials.endpoints))
            .put("token", credentials.token)
            .put("deviceId", credentials.deviceId)
            .put("deviceName", credentials.deviceName)
        preferences.edit().putString(CREDENTIALS, encrypt(json.toString())).apply()
    }

    fun clear() = preferences.edit().clear().apply()

    /** Identity source used by background coordinators to invalidate in-flight work. */
    fun currentIdentity(): Credentials? = load()

    var lastTargetId: String?
        get() = preferences.getString(LAST_TARGET, null)
        set(value) { preferences.edit().putString(LAST_TARGET, value).apply() }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
    }

    private fun encrypt(plainText: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = JSONObject()
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(plainText.toByteArray()), Base64.NO_WRAP))
        return payload.toString()
    }

    private fun decrypt(payload: String): String {
        val json = JSONObject(payload)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        val iv = Base64.decode(json.getString("iv"), Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(Base64.decode(json.getString("ciphertext"), Base64.NO_WRAP)))
    }

    private companion object {
        const val CREDENTIALS = "credentials"
        const val LAST_TARGET = "last_target"
        const val KEY_ALIAS = "linksync_device_credentials"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
