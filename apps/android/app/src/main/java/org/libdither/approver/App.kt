package org.libdither.approver

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Links.init(this)
    }
}
